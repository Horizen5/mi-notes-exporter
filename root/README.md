# root 工具集

用 root 直接读手机本地数据库，把小米便签（MIUI / HyperOS）完整导成 HTML + Markdown，私密笔记一并解成明文。

完整说明见 [../docs/使用说明-root.md](../docs/使用说明-root.md)，加密原理见 [../docs/原理-私密笔记加密.md](../docs/原理-私密笔记加密.md)。

## 快速开始

```bash
pip install -r requirements.txt

python pull.py                    # 1. root 拉取 → ./dump/extracted
python decrypt.py --sample 5      # 2. 看看私密笔记解出来对不对（可选）
python export.py                  # 3. 导出 → ./便签导出/
```

## 三个脚本

| 脚本 | 作用 | 常用参数 |
|---|---|---|
| `pull.py` | 手机端 `tar` 打包 + `adb pull` + 本地解包，全程不用点确认框 | `--out` `--serial` `--adb` |
| `decrypt.py` | 解密私密笔记（AES-256-CBC），可导出文本或写回数据库副本 | `--sample` `--txt` `--write` `--guess-iv` `--iv` |
| `export.py` | `note.db` → HTML 全集 + Markdown + 图片总览 | `--dump` `--out` `--preview` `--no-secret` |

## 产物

```
便签导出/
├── index.html        左栏分类 + 搜索，图片内联
├── 图片总览.html      所有图片铺成网格，核对完整性用
├── index.md          按分类分组的索引
├── YYYY-MM-DD_ID.md  一条便签一个文件，带 front-matter
└── images/           原图，sha1 命名 + 正确扩展名
```

## 加密参数速查

```
算法  AES-256-CBC + PKCS7
密钥  files/miui_notes_secret_2 的 32 字节原文（无派生）
IV    fc9710a048cd7a2e775396ee4280face（固定）
密文  data.content（Base64，带换行）；note.plain_text 也是密文
密码  不参与加密，只由系统校验决定能否进入界面
```

## 环境

- Python 3.9+
- `pycryptodome`
- `adb`（platform-tools）
- 手机已 root（Magisk / KernelSU / 其他 `su`）

`dump/`、`便签导出/`、`*.tgz` 都在 `.gitignore` 里，不会被提交。
