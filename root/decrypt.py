#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解密小米便签的「私密笔记」。

原理（详见 ../docs/原理-私密笔记加密.md）：
    明文 = AES-256-CBC(key, IV).decrypt(base64decode(data.content))
    key  = files/miui_notes_secret_* 那个文件的 32 字节原文，直接当 key，不做派生
    IV   = fc9710a048cd7a2e775396ee4280face（固定值，所有便签共用）
    note.plain_text 字段里也是密文，同样要解

调用你输的隐私密码跟这个完全无关：密码只由系统校验，决定界面能不能进这个文件夹。

用法：
    python decrypt.py                       # 列出结果，打印前 5 条
    python decrypt.py --sample 26           # 26 条全打印
    python decrypt.py --write               # 生成 note.decrypted.db（正文已换成明文）
    python decrypt.py --txt 私密笔记.txt      # 导出纯文本
    python decrypt.py --guess-iv            # 从已知首块明文反推 IV（换版本时用）
"""

import argparse
import base64
import glob
import os
import re
import shutil
import sqlite3
import sys

IV = bytes.fromhex("fc9710a048cd7a2e775396ee4280face")
FIRST_BLOCK = b'<text indent="1"'   # 这批便签第一块明文恒为它，正好 16 字节
PRIVATE_PID = -4                    # parent_id = -4 就是「私密笔记」


def find_key(dump):
    hits = sorted(glob.glob(os.path.join(dump, "files", "miui_notes_secret_*")))
    if not hits:
        sys.exit(
            "没找到密钥文件 %s/files/miui_notes_secret_*。\n"
            "  没有这个文件说明这台设备从没建过私密笔记，或者拉取时漏了 files/ 目录。" % dump
        )
    return hits[-1]


def b64(s):
    s = re.sub(r"\s+", "", s or "")
    if not s:
        return b""
    return base64.b64decode(s + "=" * (-len(s) % 4))


def decrypt(blob, key, iv):
    from Crypto.Cipher import AES

    raw = b64(blob)
    if not raw or len(raw) % 16:
        return None
    pt = AES.new(key, AES.MODE_CBC, iv).decrypt(raw)
    pad = pt[-1]
    if 1 <= pad <= 16 and pt[-pad:] == bytes([pad]) * pad:
        pt = pt[:-pad]
    try:
        return pt.decode("utf-8")
    except UnicodeDecodeError:
        return None


def guess_iv(key, blobs):
    """第一块明文已知时，C1 = E(P1 ^ IV) 反推：IV = D(C1) ^ P1。

    只有「第一块明文恰好是 FIRST_BLOCK」的便签才推得准，所以看出现次数最多的那个值。
    """
    from Crypto.Cipher import AES
    from collections import Counter

    ivs = []
    for blob in blobs:
        raw = b64(blob)
        if len(raw) < 16:
            continue
        d1 = AES.new(key, AES.MODE_ECB).decrypt(raw[:16])
        ivs.append(bytes(a ^ b for a, b in zip(d1, FIRST_BLOCK)).hex())
    if not ivs:
        return None
    cnt = Counter(ivs)
    print("从 %d 条样本反推 IV（只有首块是 %r 的才对得上）：" % (len(ivs), FIRST_BLOCK.decode()))
    for h, n in cnt.most_common(5):
        print("  %s  出现 %d 次" % (h, n))
    best, n = cnt.most_common(1)[0]
    print()
    print("取出现最多的：%s（%d/%d，其余样本首块不是标准 <text> 开头）" % (best, n, len(ivs)))
    print("用法：python decrypt.py --iv %s" % best)
    return best


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="解密小米便签私密笔记")
    ap.add_argument("--dump", default=os.path.join(here, "dump"), help="解包后的应用数据目录")
    ap.add_argument("--db", default=None, help="直接指定 note.db（默认取 dump/databases/note.db）")
    ap.add_argument("--sample", type=int, default=5, help="打印前几条，0 表示不打印")
    ap.add_argument("--write", action="store_true", help="生成解密后的数据库副本")
    ap.add_argument("--txt", default=None, help="导出为纯文本文件")
    ap.add_argument("--guess-iv", action="store_true", help="反推 IV 并退出")
    ap.add_argument("--iv", default=None, help="自定义 IV（16 字节 hex），不填用内置值")
    a = ap.parse_args()

    db = a.db or os.path.join(a.dump, "databases", "note.db")
    if not os.path.exists(db):
        sys.exit("找不到数据库：%s" % db)
    key_path = find_key(a.dump)
    key = open(key_path, "rb").read()
    if len(key) != 32:
        print("注意：密钥文件是 %d 字节，不是 32，可能不是 AES-256。" % len(key))

    iv = bytes.fromhex(a.iv) if a.iv else IV
    print("数据库:", db)
    print("密钥  : %s (%d 字节) %s…" % (os.path.basename(key_path), len(key), key.hex()[:16]))
    print("IV    :", iv.hex())

    c = sqlite3.connect(db)
    rows = c.execute(
        "select _id, title, created_date, plain_text from note "
        "where parent_id=? and type=0 order by _id", (PRIVATE_PID,)
    ).fetchall()
    if not rows:
        sys.exit("这个库里没有私密笔记（parent_id=%d）。" % PRIVATE_PID)

    bodies = dict(c.execute(
        "select note_id, content from data where mime_type='vnd.android.cursor.item/text_note'"
    ))

    if a.guess_iv:
        guess_iv(key, [bodies.get(r[0], "") for r in rows])
        return

    ok, fail, out = 0, 0, []
    for nid, title, created, plain in rows:
        blob = bodies.get(nid, "")
        text = decrypt(blob, key, iv)
        if text is None:
            fail += 1
            out.append((nid, title, None))
        else:
            ok += 1
            out.append((nid, title, text))
    print()
    print("私密笔记 %d 条：解开 %d，失败 %d" % (len(rows), ok, fail))
    print()
    for nid, title, text in out[: max(0, a.sample)]:
        head = (text or "").replace("\n", " ⏎ ")
        print("─" * 58)
        print("#%s  %s" % (nid, title or "(无标题)"))
        print("  " + (head[:200] if text else "解码失败"))
    if len(out) > a.sample:
        print()
        print("……其余 %d 条用 --sample %d 查看" % (len(out) - a.sample, len(out)))

    if a.txt:
        lines = ["小米便签 · 私密笔记", "共 %d 条" % len(out), ""]
        for nid, title, text in out:
            lines += ["=" * 60, "#%s  %s" % (nid, title or ""), "", text or "（解码失败）", ""]
        with open(a.txt, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("\n纯文本:", a.txt)

    if a.write:
        dst = os.path.join(os.path.dirname(db), "note.decrypted.db")
        shutil.copy2(db, dst)
        d = sqlite3.connect(dst)
        for nid, title, text in out:
            if text is None:
                continue
            d.execute(
                "update data set content=? where note_id=? and mime_type=?",
                (text, nid, "vnd.android.cursor.item/text_note"),
            )
            d.execute("update note set plain_text=? where _id=?", (text, nid))
        d.commit()
        d.close()
        print("解密后的库:", dst)
        print("  用法：python export.py --dump ", end="")
        print(os.path.dirname(os.path.dirname(dst)))


if __name__ == "__main__":
    main()
