# 方式二：Root 全量导出（MIUI / HyperOS）

直接从手机本地数据库导出，不经过云端、不打开浏览器。数据库、图片、密钥一次全拿到，**私密笔记也能解成明文**。

适用系统：MIUI 13 / 14、HyperOS 1.0 / 2.0（澎湃 OS）。两者包名都是 `com.miui.notes`，路径一致。

---

## 为什么要 root

`/data/data/com.miui.notes` 的权限是 `drwx------`，owner 是便签应用自己的 uid（实测 `u0_a237`），adb shell 是 `uid=2000`，进不去。

| 通道 | 结果 |
|---|---|
| `adb shell ls /data/data/com.miui.notes` | `Permission denied` |
| `run-as com.miui.notes` | `package not debuggable`，小米便签不是调试版 |
| `adb backup` | Android 12 起基本失效，Android 14 上实测 40 秒 0 字节，且必须屏幕点确认 |
| MIUI 本地备份 `/sdcard/MIUI/backup` | 只有 `.bak`，系统恢复工具才能读 |
| 便签内「导出」 | 只有 txt/html，图片和格式全丢 |
| **root + `su`** | **整个目录，一条 `tar` 搞定** |

没有 root 就用方式一（浏览器扩展），见 [使用说明.md](使用说明.md)。

---

## 前置条件

```bash
# 1. Python 3.9+
python --version

# 2. 加密库
pip install pycryptodome

# 3. adb（Windows）
winget install Google.PlatformTools

# 4. 手机：开发者选项 → USB 调试，插线后允许这台电脑调试
adb devices    # 应该能看到序列号和 device
```

root 用 Magisk / KernelSU 都行，只需要 `su` 能执行。第一次跑 `su` 时手机会弹授权框，点允许。

---

## 三步走

```bash
cd root

# 1. 拉数据（附件几百 MB，要等一两分钟）
python pull.py

# 2. 解密私密笔记（可选，先看看解出来对不对）
python decrypt.py --sample 5

# 3. 导出 HTML + Markdown
python export.py
```

产物在 `root/便签导出/`：

```
便签导出/
├── index.html          左栏分类 + 搜索，图片内联，双击就开
├── 图片总览.html        所有图片铺成网格，一眼核对有没有缺
├── index.md            按分类分组的索引
├── 2017-11-25_323.md   一条便签一个文件，带 front-matter
├── …
└── images/             原图，按 sha1 命名 + 正确扩展名
```

`markdown/` 里的相对路径是 `images/xxx.jpg`，所以**整个文件夹一起放进 Obsidian** 图片就能显示，不用改路径。

---

## 三个脚本

### pull.py — 拉取

用 root 在手机上打包成 tar，再 `adb pull` 回来解包。全程不需要在手机上点任何确认。

```
python pull.py                       # 拉到 ./dump
python pull.py --out D:\notes\dump   # 指定目录
python pull.py --serial 3d834389     # 多设备时指定
python pull.py --adb C:\platform-tools\adb.exe
```

拉完会打印数据库大小、附件数量、密钥文件是否存在，并清理手机上的临时包。

### decrypt.py — 解密私密笔记

```
python decrypt.py                    # 列出结果，打印前 5 条
python decrypt.py --sample 26        # 全部打印
python decrypt.py --txt 私密.txt      # 导出纯文本
python decrypt.py --write            # 生成 note.decrypted.db（正文已换成明文）
python decrypt.py --guess-iv         # 从已知首块明文反推 IV
```

`--write` 适合想把解密后的库丢给别的工具（DB Browser、脚本）直接读，不用每次都带 key。

算法参数和推导过程见 [原理-私密笔记加密.md](原理-私密笔记加密.md)。

### export.py — 导出

```
python export.py                              # 用 ./dump 和 ./便签导出
python export.py --dump ./dump --out ./out
python export.py --preview                    # 只导 5 条看效果
python export.py --no-secret                  # 不解密私密笔记
```

| 参数 | 说明 |
|---|---|
| `--dump` | 解包后的应用数据目录，需含 `databases/note.db` 和 `files/attachment` |
| `--out` | 输出目录 |
| `--preview` | 只导出前 5 条，用于核对排版 |
| `--no-secret` | 私密笔记保持密文，不加载密钥 |

导出时会自动找 `files/miui_notes_secret_*`（不写死编号），有就解密私密笔记，没有就跳过。

---

## 两种方式对比

| | 方式一：浏览器扩展 | 方式二：Root |
|---|---|---|
| 需要 root | 不需要 | 需要 |
| 数据来源 | 小米云 i.mi.com | 手机本地 `note.db` |
| 私密笔记 | 云端不解密，拿不到正文 | **可解成明文** |
| 图片 | 逐张下载，受网络和限流影响 | 原图直出，277 MB 一次到位 |
| 排版还原 | 从页面 DOM 取，所见即所得 | 从 XML 标签还原，需处理两代格式 |
| 速度 | 受反爬限制，几百条要等很久 | 条数无关，主要耗时在传文件 |
| 适合 | 普通用户、没 root、只要文字 | 已 root、要完整备份、要私密笔记 |

两边产物结构不同：扩展给的是「一个文件夹一个 md」，脚本给的是「一条便签一个 md + 一个可搜索的 HTML 全集」。

---

## 常见问题

**Q：`su` 提示 permission denied？**
手机没授权。先手动跑一次 `adb shell su -c id`，在弹窗里点「允许」，并且把「记住选择」勾上。

**Q：HyperOS 上路径不一样吗？**
一样。HyperOS 沿用了 `com.miui.notes` 包名，`/data/data/com.miui.notes/databases/note.db`。可以用 `adb shell pm list packages | grep note` 确认。

**Q：导出条数和手机上看到的不一致？**
数据库里 `note` 表混了三种行：`type=0` 是真便签（本机 750 条），`type=1` 是 19 个文件夹的实体行，`type=2` 是系统分类占位行。导出只取 `type=0`，并跳过回收站（`parent_id=-3`）里的废弃数据。手机上看到的数字如果对不上，多半是差在回收站或空便签上。

**Q：图片显示不出来？**
`images/` 必须和 html、md 在同一层。直接把 `便签导出` 整个目录搬走，不要只搬 md。

**Q：正文里有 `☺` 加一串 40 位字符？**
那是旧格式的图片占位符，`export.py` 会自动换成图片。如果还看得到原文，说明用的是旧版脚本。

**Q：私密笔记解出来是乱码？**
密钥文件编号变了或 IV 变了。跑 `python decrypt.py --guess-iv` 看反推结果，必要时用 `--iv` 指定。

**Q：能只导出某个分类吗？**
脚本导出全部，但 HTML 左栏点分类就能筛选，也支持 `index.html?cat=-4` 直接打开私密笔记。Markdown 的 `index.md` 按分类分组，`category` 写在每条 md 的 front-matter 里。

---

## 已知限制

- 密文只覆盖正文，**附件图片是明文存放在 `files/attachment/` 的**，文件名就是 sha1。所以「私密」只保护文字，图片本来就是谁拿到目录谁能看。
- XML 新格式里的 `<input type="checkbox"/>` 数据库没有勾选状态字段，统一渲染成空框；旧格式的 `□` / `■` 字符能正确区分。
- 正文里嵌的双向文本控制符（`U+202E` 等）会让人以为文字重叠、乱序，导出时会被还原成正常语序。
- `dump/` 和 `便签导出/` 都在 `.gitignore` 里，不会误传。这两样都是你手机里的原文，自己留好。
