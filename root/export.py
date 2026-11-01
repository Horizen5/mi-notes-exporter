"""把小米便签 note.db 还原成 HTML 与 Markdown。

数据来源：/data/data/com.miui.notes/databases/note.db（MIUI / HyperOS 同名包）
正文有新旧两代格式：
  旧：纯文本行，图片写成单独一行 "☺ <40位sha1>"（后面可能跟 <0/></> 旧标记）
  新：XML 行，<text indent="N">…</text> / <center> / <b> / <img fileid="<sha1>"/> / <input type="checkbox"/> …
两代的图片都能对上 files/attachment/ 里同名的文件。

用法：
    python export.py                          # 用默认的 ./dump 和 ./便签导出
    python export.py --dump ./dump --out ./out
    python export.py --preview                # 只导出 5 条看看效果
"""

import argparse
import base64
import datetime
import glob
import html
import os
import re
import shutil
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DUMP = os.path.join(HERE, "dump")
OUT = os.path.join(HERE, "便签导出")

DB = os.path.join(DUMP, "databases", "note.db")
ATTACH = os.path.join(DUMP, "files", "attachment")
IMAGES = os.path.join(OUT, "images")

SUN = "\u263a"  # ☺
IMGNAMES = {}   # sha1 -> 带扩展名的文件名，HTML 用

# 私密便签：AES-256-CBC，密钥是 files/miui_notes_secret_* 那个文件的原文，IV 是固定值
SECRET_FILE = os.path.join(DUMP, "files", "miui_notes_secret_2")
SECRET_IV = bytes.fromhex("fc9710a048cd7a2e775396ee4280face")
SECRET_OFF = False
_SECRET_KEY = None


def configure(dump, out):
    """把 --dump / --out 灌进全局路径。"""
    global DUMP, OUT, DB, ATTACH, IMAGES, SECRET_FILE, _SECRET_KEY
    DUMP = os.path.abspath(dump)
    OUT = os.path.abspath(out)
    DB = os.path.join(DUMP, "databases", "note.db")
    ATTACH = os.path.join(DUMP, "files", "attachment")
    IMAGES = os.path.join(OUT, "images")
    found = sorted(glob.glob(os.path.join(DUMP, "files", "miui_notes_secret_*")))
    SECRET_FILE = found[-1] if found else os.path.join(DUMP, "files", "miui_notes_secret_2")
    _SECRET_KEY = None


def _secret_key():
    global _SECRET_KEY
    if _SECRET_KEY is None and os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "rb") as f:
            _SECRET_KEY = f.read()
    return _SECRET_KEY


def decrypt_secret(body):
    """把私密便签的 base64 密文解成明文。失败就原样返回。"""
    key = _secret_key()
    if not key:
        return body
    try:
        from Crypto.Cipher import AES

        s = re.sub(r"\s+", "", body)
        raw = base64.b64decode(s + "=" * (-len(s) % 4))
        if not raw or len(raw) % 16:
            return body
        pt = AES.new(key, AES.MODE_CBC, SECRET_IV).decrypt(raw)
        pad = pt[-1]
        if 1 <= pad <= 16 and pt[-pad:] == bytes([pad]) * pad:
            pt = pt[:-pad]
        return pt.decode("utf-8")
    except Exception:
        return body


# ---------------------------------------------------------------- 取数据

def fmt(ms):
    if not ms:
        return ""
    return datetime.datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M")


def load():
    c = sqlite3.connect(DB)
    # type=0 才是真便签；type=1 是分类实体行，type=2 是系统分类占位行，都不是便签
    # parent_id=-3 是回收站，只有两条废弃测试数据，不导出
    notes = c.execute(
        "select _id, parent_id, title, plain_text, created_date, modified_date, note_content_type, "
        "       alert_date, bg_color_id, has_attachment, deletion_tag "
        "from note where type=0 and parent_id!=-3 order by modified_date desc"
    ).fetchall()
    bodies, imgmap = {}, {}
    for nid, body in c.execute(
        "select note_id, content from data "
        "where mime_type='vnd.android.cursor.item/text_note'"
    ):
        bodies[nid] = body or ""
    for nid, sha in c.execute(
        "select note_id, content from data where mime_type like 'image/%'"
    ):
        imgmap.setdefault(nid, []).append(sha)

    folders = load_folders(c)
    out = []
    for nid, pid, title, plain, cd, md, ctype, alert, bg, hasatt, deltag in notes:
        body = bodies.get(nid, "")
        # 私密便签：库里 body 和 plain_text 都是密文，两个都要解
        if pid == -4 and not SECRET_OFF:
            if body:
                body = decrypt_secret(body)
            if plain:
                plain = decrypt_secret(plain)
        out.append(
            dict(
                id=nid,
                parent=pid,
                cat=folders.get(pid, SYS_CATS.get(pid, "")),
                title=(title or "").strip(),
                plain=plain or "",
                body=body,
                created=fmt(cd),
                modified=fmt(md),
                alert=fmt(alert),
                ctype=ctype,
                imgs=imgmap.get(nid, []),
                deltag=deltag,
                snippet=(plain or "").strip()[:80] or body[:80],
            )
        )
    return out


# 系统分类：parent_id 为负数或 0 的固定分组，名字不在数据库里
SYS_CATS = {0: "未分类", -4: "私密笔记", -3: "最近删除"}

def load_folders(c):
    """parent_id -> 分类名。type=1 的行是用户自建文件夹，subject 就是名字。"""
    d = dict(SYS_CATS)
    for fid, subj in c.execute(
        "select _id, subject from note where type=1 and subject is not null and subject!=''"
    ):
        d[fid] = subj
    return d


def load_categories():
    """侧栏分类树。文件夹按 subject 升序，和手机上的排列一致。"""
    c = sqlite3.connect(DB)
    folders = []
    for fid, subj in c.execute(
        "select _id, subject from note where type=1 and subject is not null and subject!='' "
        "order by subject"
    ):
        n = c.execute(
            "select count(*) from note where parent_id=? and type=0", (fid,)
        ).fetchone()[0]
        folders.append({"id": str(fid), "name": subj, "count": n})

    def cnt(pid):
        return c.execute(
            "select count(*) from note where parent_id=? and type=0", (pid,)
        ).fetchone()[0]

    total = c.execute(
        "select count(*) from note where type=0 and parent_id!=-3"
    ).fetchone()[0]
    counts = {
        "all": total,
        "0": cnt(0),
        "-4": cnt(-4),
    }
    c.close()
    return [
        {"id": "all", "name": "全部笔记", "count": counts["all"], "icon": "list"},
        {"id": "0", "name": "未分类", "count": counts["0"], "icon": "doc"},
        {
            "id": "group",
            "name": "我的文件夹",
            "count": sum(f["count"] for f in folders),
            "icon": "folder",
            "group": True,
            "children": folders,
        },
        {"id": "-4", "name": "私密笔记", "count": counts["-4"], "icon": "lock"},
    ]


def is_encrypted(note):
    """正文是密文：整体像 base64，解开是二进制，不是可读文本。"""
    b = (note["body"] or "").strip()
    if not b:
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9+/=\s]+", b)) and len(b) > 40 and " " not in b


# ---------------------------------------------------------------- 渲染

INLINE_OPEN = {
    "b": ("<strong>", "</strong>"),
    "u": ("<u>", "</u>"),
    "i": ("<em>", "</em>"),
    "size": ('<span style="font-size:1.2em">', "</span>"),
    "mid-size": ('<span style="font-size:1.1em">', "</span>"),
}
BLOCK_ALIGN = {"center": "center", "right": "right"}

# 只认已知标签，避免正文里的普通 '<' 被当成标签吞掉
TAG_RE = re.compile(
    r"</?(?:text|center|right|background|size|mid-size|b|u|i|img|input|hr|new-format|0)\b[^>]*>"
    r"|</>"
)
# 旧格式的图片行：☺ <sha1>，有时后面跟着旧标记 <0/></>
IMG_LINE_RE = re.compile(r"☺\s*([0-9a-f]{40})")


def normalize(body):
    """把新旧两种写法统一成 XML 标签形式。"""
    body = body.replace("<0/></>", "").replace("</>", "")
    body = strip_bidi(body)
    return IMG_LINE_RE.sub(lambda m: '<img fileid="%s" imgshow="0" imgdes="" />' % m.group(1), body)


# 双向文本控制符：会让中文反向显示、字符叠在一起
BIDI_RE = re.compile(
    "[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069\ufeff\u200b\u200c\u200d]"
)
# 被 RLO…PDF 包住的片段，屏幕上是被倒着显示的，这里还原成正常语序
RLO_RUN = re.compile("\u202e([^\u202c]*)\u202c")


def strip_bidi(s):
    """清掉不可见控制符，并把被 RLO 倒序的片段还原。"""
    if not s:
        return s
    s = RLO_RUN.sub(lambda m: m.group(1)[::-1], s)
    return BIDI_RE.sub("", s)


def esc(s):
    return html.escape(strip_bidi(s)).replace(" ", "&nbsp;")


def esc_text(s):
    """普通文本，顺带把 □ / ■ 还原成复选框。"""
    s = html.escape(strip_bidi(s)).replace(" ", "&nbsp;")
    s = s.replace("■", '<span class="cb on">☑</span>')
    s = s.replace("□", '<span class="cb">☐</span>')
    return s


def img_tag(sha, rel):
    if not sha:
        return '<p class="miss">[图片引用为空]</p>'
    if not os.path.exists(os.path.join(ATTACH, sha)):
        return '<p class="miss">[图片缺失 %s]</p>' % html.escape(sha[:12])
    return '<img class="att" src="%s/%s" loading="lazy" alt="">' % (
        rel, IMGNAMES.get(sha, sha))


def render_plain(text, rel):
    """旧格式：纯文本 + ☺ 图片行。"""
    out = []
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith(SUN):
            sha = s[len(SUN):].split("<")[0].strip()
            out.append(img_tag(sha, rel))
        elif s == "":
            out.append('<p class="gap">&nbsp;</p>')
        else:
            out.append("<p>%s</p>" % esc_text(line))
    return "\n".join(out)


def render_xml(text, rel):
    """新格式：按标签渲染。"""
    out = []
    align, indent, bg = [], [], []
    buf = []

    def flush():
        if not buf:
            return
        s = "".join(buf)
        buf.clear()
        st = []
        if indent and indent[-1]:
            try:
                lv = int(indent[-1])
            except (TypeError, ValueError):
                lv = 1
            if lv > 1:
                st.append("margin-left:%dpx" % (18 * (lv - 1)))
        if align:
            st.append("text-align:%s" % align[-1])
        if bg:
            st.append("background:%s" % bg[-1])
        out.append('<p%s>%s</p>' % ((' style="%s"' % ";".join(st)) if st else "", s))

    token = TAG_RE
    i, n = 0, len(text)
    while i < n:
        m = token.search(text, i)
        seg = text[i:m.start()] if m else text[i:]
        for ch in seg:
            if ch == "\n":
                flush()
            else:
                buf.append(esc_text(ch))
        if not m:
            break
        tag = m.group(0)
        nm = re.match(r"</?([a-zA-Z0-9-]+)", tag)
        nm = nm.group(1).lower() if nm else ""
        closing = tag.startswith("</")

        if nm == "img" and not closing:
            flush()
            fm = re.search(r'fileid="([^"]+)"', tag)
            out.append(img_tag(fm.group(1) if fm else "", rel))
        elif nm == "input" and not closing:
            flush()
            lv = re.search(r'level="(\d+)"', tag)
            done = bool(lv) and lv.group(1) not in ("0", "1")
            out.append('<span class="cb">%s</span>' % ("☑" if done else "☐"))
        elif nm == "hr":
            flush()
            out.append("<hr>")
        elif nm == "text" and not closing:
            flush()
            im = re.search(r'indent="([^"]*)"', tag)
            indent.append(im.group(1) if im else "1")
        elif nm == "text" and closing:
            flush()
            if indent:
                indent.pop()
        elif nm in BLOCK_ALIGN and not closing:
            flush()
            align.append(BLOCK_ALIGN[nm])
        elif nm in BLOCK_ALIGN and closing:
            flush()
            if align:
                align.pop()
        elif nm == "background" and not closing:
            cm = re.search(r'color\s*=\s*"([^"]*)"', tag)
            bg.append(cm.group(1) if cm else "")
        elif nm == "background" and closing:
            flush()
            if bg:
                bg.pop()
        elif nm in INLINE_OPEN and not closing:
            buf.append(INLINE_OPEN[nm][0])
        elif nm in INLINE_OPEN and closing:
            buf.append(INLINE_OPEN[nm][1])
        # <0/></> 与 <new-format/> 是旧标记，忽略
        i = m.end()
    flush()
    return "\n".join(out)


def render(note, rel):
    body = note["body"]
    if not body:
        return '<p class="miss">（正文为空）</p>'
    if is_encrypted(note):
        return '<p class="miss">（加密便签，数据库中为密文，未能还原）</p>'
    body = normalize(body)
    if TAG_RE.search(body):
        return render_xml(body, rel)
    return render_plain(body, rel)


# ---------------------------------------------------------------- 输出

CSS = """
:root{--fg:#1f2328;--mut:#8b949e;--line:#e6e8eb;--bg:#fff;--accent:#2f6fed}
*{box-sizing:border-box}
body{margin:0;background:#f6f7f9;color:var(--fg);
     font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.95);
       backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:14px 20px}
h1{margin:0 0 10px;font-size:18px;font-weight:600}
#q{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;
   font-size:14px;background:#fff;color:var(--fg)}
#st{color:var(--mut);font-size:12px;margin-top:8px}
.shell{display:flex;align-items:flex-start;gap:0}
nav.side{position:sticky;top:104px;flex:0 0 232px;width:232px;height:calc(100vh - 104px);
     overflow-y:auto;padding:14px 10px 40px;border-right:1px solid var(--line);background:var(--bg)}
/* 图标统一尺寸，侧栏里任何 svg 都不许自己撑开 */
.ic{flex:0 0 18px;width:18px;height:18px;min-width:18px;max-width:18px;opacity:.75}
nav.side .grp{color:var(--mut);font-size:12px;padding:14px 10px 6px;display:flex;
     align-items:center;gap:6px;user-select:none;cursor:pointer;white-space:nowrap}
nav.side .grp .arrow{transition:transform .15s;display:inline-block;font-size:10px;flex:0 0 auto}
nav.side .grp.closed .arrow{transform:rotate(-90deg)}
nav.side .grp .body{max-height:1200px;overflow:hidden;transition:max-height .18s}
nav.side .grp.closed .body{max-height:0}
nav.side .grp .gt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cat{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:8px;
     cursor:pointer;font-size:14px;color:var(--fg);user-select:none;white-space:nowrap}
.cat:hover{background:#f0f2f5}
.cat.on{background:#e8f0fe;color:var(--accent);font-weight:500}
.cat.on .ic{opacity:1}
.cat .tx{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cat .n{font-size:12px;color:var(--mut);flex:0 0 auto}
.cat.on .n{color:var(--accent)}
.cat.sub{padding-left:26px;font-size:13px}
main{flex:1;min-width:0;max-width:840px;margin:0 auto;padding:20px 16px 100px}
.note{background:var(--bg);border:1px solid var(--line);border-radius:12px;
      padding:16px 18px;margin:14px 0;overflow:hidden}
.note>summary{cursor:pointer;list-style:none}
.note>summary::-webkit-details-marker{display:none}
.meta{color:var(--mut);font-size:12px;display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.meta .tag{background:#f0f2f5;border-radius:4px;padding:0 6px}
.ttl{font-weight:600;font-size:15px}
/* 折叠态摘要：只露两行，超出裁掉，不让它溢出卡片 */
.snip{color:#4b5563;font-size:13px;margin-top:2px;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
      overflow:hidden;overflow-wrap:anywhere;word-break:break-word;
      max-height:3.4em;white-space:normal}
.body{margin-top:12px;border-top:1px dashed var(--line);padding-top:12px;
      overflow-wrap:anywhere;word-break:break-word}
.body p{margin:3px 0;white-space:pre-wrap;word-break:break-word}
.body p.gap{margin:0;height:.5em}
.body hr{border:none;border-top:1px solid var(--line);margin:12px 0}
.att{max-width:100%;height:auto;border-radius:8px;margin:8px 0;display:block;border:1px solid #eee}
.cb{font-size:17px;margin-right:6px}
.miss{color:#b45309;font-size:13px}
@media (max-width:760px){
  .shell{flex-direction:column}
  nav.side{position:static;width:100%;flex:none;height:auto;max-height:240px;
           border-right:none;border-bottom:1px solid var(--line)}
  main{max-width:100%}
}
"""

# 侧栏图标：纯 SVG，跟手机上的线性图标风格一致
ICONS = {
    "list": '<path d="M4 6h16M4 12h16M4 18h10"/>',
    "doc": '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
    "folder": '<path d="M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    "lock": '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    "trash": '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
}


def icon(name, cls="ic"):
    return (
        '<svg class="%s" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">%s</svg>'
        % (cls, ICONS.get(name, ICONS["doc"]))
    )


def build_sidebar(cats):
    """左侧分类栏，结构和手机侧边栏一致。"""
    out = []
    for c in cats:
        if c.get("group"):
            rows = [
                '<div class="cat sub" data-cat="%s"><span class="tx">%s</span>'
                '<span class="n">%d</span></div>'
                % (html.escape(f["id"]), html.escape(f["name"]), f["count"])
                for f in c["children"]
            ]
            out.append(
                '<div class="grp" data-grp><span class="arrow">▼</span>%s'
                '<span class="gt">%s</span><span class="n">%d</span></div>'
                '<div class="body">%s</div>'
                % (icon(c["icon"]), html.escape(c["name"]), c["count"], "".join(rows))
            )
        else:
            out.append(
                '<div class="cat" data-cat="%s">%s<span class="tx">%s</span>'
                '<span class="n">%d</span></div>'
                % (html.escape(c["id"]), icon(c["icon"]), html.escape(c["name"]), c["count"])
            )
    return '<nav class="side">%s</nav>' % "".join(out)


JS = """
const q=document.getElementById('q'), st=document.getElementById('st');
const all=document.querySelectorAll('details.note');
let cat='all';
function run(){
  const v=q.value.trim().toLowerCase();
  let shown=0;
  all.forEach(d=>{
    const okCat = cat==='all' || d.dataset.cat===cat;
    const hit=okCat && (!v||d.dataset.text.includes(v));
    d.style.display=hit?'':'none';
    if(hit){shown++; if(v) d.open=true;}
  });
  const total=all.length;
  st.textContent='显示 '+shown+' / '+total+' 条'+(cat==='all'?'':'（已按分类筛选）');
}
q.addEventListener('input',run);
document.querySelectorAll('.cat').forEach(el=>{
  el.addEventListener('click',()=>{
    document.querySelectorAll('.cat').forEach(x=>x.classList.remove('on'));
    el.classList.add('on');
    cat=el.dataset.cat;
    history.replaceState(null,'','?cat='+encodeURIComponent(cat));
    run();
  });
});
document.querySelectorAll('.grp').forEach(g=>{
  g.addEventListener('click',()=>g.classList.toggle('closed'));
});
// 支持用 ?cat=xxx 直接打开某个分类
const want=new URLSearchParams(location.search).get('cat');
if(want!==null){
  const hit=document.querySelector('.cat[data-cat="'+want+'"]');
  if(hit){ hit.classList.add('on'); cat=want; }
}
run();
"""


def preview_text(note, limit=120):
    """折叠态摘要：剥掉标签和占位符，只留可读文字，避免原文标记外溢。"""
    raw = (note["plain"] or "").strip()
    if not raw:
        raw = TAG_RE.sub(" ", note["body"] or "")
        raw = IMG_LINE_RE.sub(" ", raw)
    raw = raw.replace(SUN, " ")
    raw = strip_bidi(raw)
    raw = re.sub(r"[0-9a-f]{40}", " ", raw)
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", " ", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    if len(raw) > limit:
        raw = raw[:limit].rstrip() + "…"
    return raw or "（无文字内容，点开查看）"


def build_html(notes, out_path, rel, title, cats=None):
    parts = []
    for n in notes:
        body = render(n, rel)
        preview = preview_text(n)
        cat_tag = (
            '<span class="tag">%s</span>' % html.escape(n["cat"]) if n.get("cat") else ""
        )
        parts.append(
            '<details class="note" data-cat="%s" data-text="%s"><summary>'
            '<div class="meta"><span>%s</span><span>修改 %s</span><span>%s</span>%s'
            "<span>图 %d</span>%s</div>"
            '<div class="ttl">%s</div><div class="snip">%s</div></summary>'
            '<div class="body">%s</div></details>'
            % (
                html.escape(str(n["parent"])),
                html.escape(strip_bidi((n["plain"] + " " + n["body"]).lower()[:4000])),
                html.escape(n["created"] or "—"),
                html.escape(n["modified"] or "—"),
                html.escape(n["ctype"] or ""),
                cat_tag,
                len(n["imgs"]),
                ("<span>提醒 %s</span>" % html.escape(n["alert"])) if n["alert"] else "",
                html.escape(n["title"] or "无标题"),
                html.escape(preview),
                body,
            )
        )
    side = build_sidebar(cats) if cats else ""
    page = (
        "<!doctype html><html lang=zh-CN><head><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>%s</title><style>%s</style></head><body>"
        "<header><h1>%s</h1><input id=q type=search placeholder='搜索标题与正文…'>"
        "<div id=st></div></header><div class=shell>%s<main>%s</main></div>"
        "<script>%s</script></body></html>"
        % (html.escape(title), CSS, html.escape(title), side, "\n".join(parts), JS)
    )
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(page)
    return out_path


def link_images():
    """把附件硬链接到 images/ 并补上正确扩展名，方便 Markdown 渲染器识别。"""
    os.makedirs(IMAGES, exist_ok=True)
    names = {}
    for fn in os.listdir(ATTACH):
        src = os.path.join(ATTACH, fn)
        with open(src, "rb") as f:
            h = f.read(8)
        ext = ".png" if h[:8] == b"\x89PNG\r\n\x1a\n" else ".jpg"
        dst = os.path.join(IMAGES, fn + ext)
        if not os.path.exists(dst):
            try:
                os.link(src, dst)
            except OSError:
                shutil.copy2(src, dst)
        names[fn] = fn + ext
    return names


MD_INLINE = {"b": "**", "i": "*", "u": "<u>"}


def md_escape(s):
    """转义会破坏 Markdown 的符号，同时把 □ / ■ 转成可读符号。"""
    out = []
    for ch in s:
        if ch in "\\`*_[]":
            out.append("\\" + ch)
        elif ch == "■":
            out.append("☑")
        elif ch == "□":
            out.append("☐")
        else:
            out.append(ch)
    return "".join(out)


def md_tag(tag, imgmap):
    """单个标签转 Markdown。"""
    nm = re.match(r"</?([a-zA-Z0-9-]+)", tag)
    nm = nm.group(1).lower() if nm else ""
    closing = tag.startswith("</")
    if nm in MD_INLINE:
        return MD_INLINE[nm] if not closing else (
            "**" if nm == "b" else ("*" if nm == "i" else "</u>"))
    if nm == "img" and not closing:
        fm = re.search(r'fileid="([^"]+)"', tag)
        sha = fm.group(1) if fm else ""
        return "![](images/%s)" % imgmap.get(sha, sha)
    if nm == "input" and not closing:
        lv = re.search(r'level="(\d+)"', tag)
        done = bool(lv) and lv.group(1) not in ("0", "1")
        return "- [%s] " % ("x" if done else " ")
    if nm == "hr":
        return "\n---\n"
    if nm in ("text", "center", "right", "background", "size", "mid-size",
              "new-format", "0") or nm == "":
        return ""
    return ""


def md_line(s, imgmap):
    """一行内容转 Markdown，保留行内样式与图片、复选框的位置。"""
    out = []
    pos = 0
    for m in TAG_RE.finditer(s):
        out.append(md_escape(s[pos:m.start()]))
        out.append(md_tag(m.group(0), imgmap))
        pos = m.end()
    out.append(md_escape(s[pos:]))
    line = "".join(out).strip()
    # 行首的 □ / ■ 转成任务列表
    if line.startswith("☐"):
        line = "- [ ] " + line[1:].strip()
    elif line.startswith("☑"):
        line = "- [x] " + line[1:].strip()
    return line


def md_text(note, imgmap):
    if is_encrypted(note):
        return "> （加密便签，数据库中为密文，未能还原）"
    body = note["body"]
    lines = []
    if re.search(r"<(text|img|center|b|i|u|input|hr|background)\b", body):
        for raw in body.split("\n"):
            s = raw.strip()
            if not s:
                lines.append("")
                continue
            lines.append(md_line(s, imgmap))
    else:
        for raw in body.split("\n"):
            s = raw.strip()
            if s.startswith(SUN):
                sha = s[len(SUN):].split("<")[0].strip()
                lines.append("![](images/%s)" % imgmap.get(sha, sha))
            elif s == "":
                lines.append("")
            else:
                lines.append(md_line(raw, imgmap))
    return "\n".join(lines).strip()


def build_md(notes, imgmap):
    os.makedirs(OUT, exist_ok=True)
    index = ["# 小米便签导出", "",
             "共 %d 条，正文与图片都在本目录，images/ 里是原图。" % len(notes), ""]
    bycat = {}
    for n in notes:
        fn = "%s_%s.md" % (n["created"][:10] or "0000-00-00", n["id"])
        head = [
            "---",
            "id: %s" % n["id"],
            "created: %s" % (n["created"] or ""),
            "modified: %s" % (n["modified"] or ""),
            "type: %s" % n["ctype"],
            "category: %s" % (n.get("cat") or "未分类"),
            "images: %d" % len(n["imgs"]),
            "---",
            "",
        ]
        with open(os.path.join(OUT, fn), "w", encoding="utf-8") as f:
            f.write("\n".join(head) + md_text(n, imgmap) + "\n")
        label = n.get("cat") or "未分类"
        bycat.setdefault(label, []).append(
            (n["title"] or (n["snippet"][:30] or "无标题"), fn, n["modified"])
        )

    index.append("## 按分类")
    for cat in sorted(bycat, key=lambda k: (k == "未分类", k)):
        index.append("")
        index.append("### %s（%d）" % (cat, len(bycat[cat])))
        for title, fn, mod in bycat[cat]:
            index.append("- [%s](%s) — %s" % (title, fn, mod))

    index.append("")
    index.append("## 全部")
    for n in notes:
        fn = "%s_%s.md" % (n["created"][:10] or "0000-00-00", n["id"])
        index.append("- [%s](%s) — %s" % (
            n["title"] or (n["snippet"][:30] or "无标题"), fn, n["modified"]))
    with open(os.path.join(OUT, "index.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(index) + "\n")
    return OUT


def build_gallery(notes, imgmap):
    """图片总览页：一眼确认所有图片文件是否完好。"""
    used = {}
    for n in notes:
        for sha in n["imgs"]:
            used.setdefault(sha, []).append(n["id"])
    cards = []
    for sha in sorted(used, key=lambda s: used[s][0]):
        name = imgmap.get(sha, sha)
        cards.append(
            '<figure><img src="images/' + name + '" loading="lazy">'
            "<figcaption>" + sha[:10] + "<br>便签 "
            + ", ".join(str(i) for i in used[sha][:4]) + "</figcaption></figure>"
        )
    css = (
        "body{margin:0;padding:20px;background:#f6f7f9;color:#1f2328;"
        "font:14px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif}"
        "h1{font-size:16px;font-weight:500;margin:0 0 4px}"
        "p.sub{color:#8b949e;margin:0 0 16px;font-size:12px}"
        ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}"
        "figure{margin:0;background:#fff;border:1px solid #e6e8eb;border-radius:10px;padding:10px}"
        "img{width:100%;height:auto;border-radius:6px;display:block;background:#fafafa}"
        "figcaption{font-size:11px;color:#8b949e;margin-top:8px;word-break:break-all}"
    )
    head = (
        "<!doctype html><meta charset=utf-8><title>图片总览</title><style>" + css + "</style>"
        "<h1>图片总览</h1><p class=sub>共 " + str(len(used)) + " 张，分布在 "
        + str(len({i for v in used.values() for i in v})) + " 条便签里</p>"
        '<div class="grid">' + "".join(cards) + "</div>"
    )
    p = os.path.join(OUT, "图片总览.html")
    with open(p, "w", encoding="utf-8") as f:
        f.write(head)
    return p


def main():
    ap = argparse.ArgumentParser(description="小米便签 note.db → HTML / Markdown / 图片总览")
    ap.add_argument("--dump", default=DUMP,
                    help="手机数据目录的解包位置，需含 databases/note.db 与 files/attachment（默认 ./dump）")
    ap.add_argument("--out", default=OUT, help="输出目录（默认 ./便签导出）")
    ap.add_argument("--preview", action="store_true", help="只导出 5 条，看效果用")
    ap.add_argument("--no-secret", action="store_true", help="不解密私密笔记，原样输出密文")
    a = ap.parse_args()

    global SECRET_OFF
    SECRET_OFF = a.no_secret
    configure(a.dump, a.out)

    if not os.path.exists(DB):
        sys.exit("找不到数据库：%s\n先用 pull.py 把手机数据拉下来，或用 --dump 指到解包目录。" % DB)
    if not os.path.isdir(ATTACH):
        sys.exit("找不到附件目录：%s" % ATTACH)

    notes = load()
    cats = load_categories()
    os.makedirs(OUT, exist_ok=True)
    imgmap = link_images()
    IMGNAMES.update(imgmap)
    print("便签 %d 条，图片 %d 张" % (len(notes), len(imgmap)))
    if not SECRET_OFF and _secret_key():
        print("私密笔记：已用 %s 解密" % os.path.basename(SECRET_FILE))

    if a.preview:
        notes = notes[:5]
        p = build_html(notes, os.path.join(OUT, "preview.html"), "images", "小米便签预览", cats)
        print("预览:", p, len(notes), "条")
        return

    p = build_html(notes, os.path.join(OUT, "index.html"), "images", "小米便签全集", cats)
    print("HTML:", p)
    d = build_md(notes, imgmap)
    print("Markdown:", d)
    g = build_gallery(notes, imgmap)
    print("图片总览:", g)


if __name__ == "__main__":
    main()
