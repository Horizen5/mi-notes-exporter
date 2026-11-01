#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 root 把小米便签（MIUI / HyperOS 的 com.miui.notes）整个数据目录拉到电脑。

不依赖 adb backup，也不需要在手机上点任何确认框：
    su -c "tar czf /data/local/tmp/xxx.tgz /data/data/com.miui.notes"
本地再解包，数据库、附件、密钥文件一次全拿到。

用法：
    python pull.py                    # 拉到 ./dump
    python pull.py --out ./dump       # 指定目录
    python pull.py --serial 3d834389  # 多台设备时指定
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import tarfile
import time

PKG = "com.miui.notes"
DEV_TMP = "/data/local/tmp/mi_notes_dump.tgz"


def find_adb():
    """优先 PATH，其次常见安装位置。"""
    for name in ("adb", "adb.exe"):
        p = shutil.which(name)
        if p:
            return p

    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    roots = [v for v in (os.environ.get("LOCALAPPDATA"), os.environ.get("APPDATA")) if v]
    roots += [
        os.path.join(home, "AppData", "Local"),
        os.path.join(home, "AppData", "Roaming"),
    ]

    pats = []
    for r in roots:
        pats += [
            os.path.join(r, "Microsoft", "WinGet", "Links", "adb.exe"),
            os.path.join(r, "Microsoft", "WinGet", "Packages", "*PlatformTools*", "platform-tools", "adb.exe"),
            os.path.join(r, "Microsoft", "WinGet", "Packages", "*PlatformTools*", "*", "adb.exe"),
            os.path.join(r, "Android", "Sdk", "platform-tools", "adb.exe"),
        ]
    pats += [
        "/usr/local/bin/adb",
        "/usr/bin/adb",
        "/opt/homebrew/bin/adb",
        os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"),
        os.path.expanduser("~/Android/Sdk/platform-tools/adb"),
    ]
    for pat in pats:
        for hit in glob.glob(pat):
            if os.path.isfile(hit):
                return hit

    # 最后一招：WinGet 包目录浅扫一层
    for r in roots[:1]:
        base = os.path.join(r, "Microsoft", "WinGet", "Packages")
        if not os.path.isdir(base):
            continue
        for d in os.listdir(base):
            for sub in ("platform-tools", "."):
                cand = os.path.join(base, d, sub, "adb.exe")
                if os.path.isfile(cand):
                    return cand

    sys.exit(
        "找不到 adb。装一下 platform-tools，或者用 --adb 指定路径：\n"
        "  winget install Google.PlatformTools\n"
        "  python pull.py --adb C:\\platform-tools\\adb.exe"
    )


def sh(adb, args, serial=None, timeout=180):
    """跑 adb，返回 (returncode, stdout, stderr)。"""
    cmd = [adb]
    if serial:
        cmd += ["-s", serial]
    cmd += args
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return (
        r.returncode,
        r.stdout.decode("utf-8", "replace"),
        r.stderr.decode("utf-8", "replace"),
    )


def main():
    ap = argparse.ArgumentParser(description="用 root 全量拉取小米便签数据目录")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "dump"))
    ap.add_argument("--serial", default=None, help="多设备时指定 adb 序列号")
    ap.add_argument("--adb", default=None, help="adb 的完整路径，不填自动找")
    ap.add_argument("--package", default=PKG)
    a = ap.parse_args()

    adb = a.adb or find_adb()
    print("adb:", adb)

    # 1) 设备
    code, out, err = sh(adb, ["devices"])
    lines = [l for l in out.splitlines()[1:] if l.strip()]
    if not lines:
        sys.exit("没有检测到设备。USB 连上、开开发者选项里的 USB 调试，然后重新跑。")
    for l in lines:
        print("  设备:", l.strip())

    # 2) root
    code, out, err = sh(adb, ["shell", "su -c id"], a.serial)
    if "uid=0" not in out:
        sys.exit(
            "root 不可用。\n"
            "  返回: %s\n"
            "  这个脚本走的是 su，需要 Magisk / KernelSU 之类的 root。\n"
            "  没有 root 请用另一种方式：浏览器扩展（见 docs/使用说明.md）。" % (out.strip() or err.strip())
        )
    print("root: 可用")

    # 3) 手机上打包
    device_pkg = "/data/data/%s" % a.package
    code, out, err = sh(
        adb, ["shell", "su -c 'test -d %s && echo yes'" % device_pkg], a.serial, timeout=30
    )
    if "yes" not in out:
        sys.exit("手机上找不到 %s。确认便签应用装过、且包名没变。" % device_pkg)

    print("打包中（附件几百 MB，要等一会儿）…")
    t0 = time.time()
    tar_cmd = (
        "su -c 'tar czf %s -C %s . && chmod 666 %s && echo DONE'"
        % (DEV_TMP, device_pkg, DEV_TMP)
    )
    code, out, err = sh(adb, ["shell", tar_cmd], a.serial, timeout=1800)
    if "DONE" not in out:
        sys.exit("手机端打包失败：%s %s" % (out.strip(), err.strip()))
    code, out, err = sh(adb, ["shell", "ls -l %s" % DEV_TMP], a.serial, timeout=30)
    print("  远端:", out.strip())
    print("  耗时: %.1fs" % (time.time() - t0))

    # 4) 拉回来
    os.makedirs(a.out, exist_ok=True)
    local_tgz = os.path.join(a.out, "mi_notes_dump.tgz")
    print("传输中…")
    code, out, err = sh(adb, ["pull", DEV_TMP, local_tgz], a.serial, timeout=3600)
    if code != 0 or not os.path.exists(local_tgz):
        sys.exit("pull 失败：%s" % (out + err).strip())
    print("  已下载 %.1f MB" % (os.path.getsize(local_tgz) / 1048576))

    # 5) 解包
    extract = os.path.join(a.out, "extracted")
    if os.path.isdir(extract):
        shutil.rmtree(extract)
    os.makedirs(extract, exist_ok=True)
    print("解包到", extract)
    with tarfile.open(local_tgz, "r:gz") as tf:
        try:
            tf.extractall(extract, filter="data")   # Python 3.12+
        except TypeError:
            tf.extractall(extract)

    # 6) 清理手机上的临时包
    sh(adb, ["shell", "su -c 'rm -f %s'" % DEV_TMP], a.serial, timeout=30)

    # 7) 自检
    db = os.path.join(extract, "databases", "note.db")
    attach = os.path.join(extract, "files", "attachment")
    secret = glob.glob(os.path.join(extract, "files", "miui_notes_secret_*"))
    print()
    print("完成：")
    print("  数据库 :", db, "%.1f MB" % (os.path.getsize(db) / 1048576) if os.path.exists(db) else "缺失")
    if os.path.isdir(attach):
        n = len(os.listdir(attach))
        sz = sum(os.path.getsize(os.path.join(attach, f)) for f in os.listdir(attach))
        print("  附件   : %d 个，%.0f MB" % (n, sz / 1048576))
    print("  密钥   :", secret[0] if secret else "没有（说明没设过私密笔记）")
    print()
    print("下一步：python export.py --dump %s" % extract)


if __name__ == "__main__":
    main()
