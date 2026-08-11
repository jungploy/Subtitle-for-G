#!/usr/bin/env python3
# bump_build.py - Subtitle-for-G 构建版本号管理
#
# 规则（与用户约定一致）：
#   - 版本号四段：<prefix>.<build>，例如 0.1.0.12
#   - 最后一段 build = 累计构建次数，每次构建 +1（本脚本负责 +1）
#   - 前三段 prefix（如 0.1.0）由人工在 version.json 里改动，改 prefix 不清零 build
#
# 用法：在构建 exe 之前调用 `python scripts/bump_build.py`
#   - 读取 version.json，build +1，写回
#   - 生成 python_app/_version.py（供 main.py 以 `from _version import VERSION` 读取）
#   - 生成 version_info.txt（PyInstaller VERSIONINFO，写入 exe 文件属性）
#   - 打印最终版本号（便于构建脚本/日志回显）

import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    vp = os.path.join(BASE, "version.json")
    with open(vp, encoding="utf-8") as f:
        v = json.load(f)

    # build 自增
    v["build"] = int(v.get("build", 0)) + 1

    # 规范化 prefix 为整数段列表（用于文件属性四段版本号）
    prefix_parts = [int(x) for x in str(v.get("prefix", "0.0.0")).split(".") if x != ""]
    full = prefix_parts + [int(v["build"])]
    while len(full) < 4:
        full.append(0)
    full = full[:4]

    version = f'{v["prefix"]}.{v["build"]}'

    with open(vp, "w", encoding="utf-8") as f:
        json.dump(v, f, ensure_ascii=False, indent=2)

    # 1) python_app/_version.py —— 运行期直接 import
    py_path = os.path.join(BASE, "python_app", "_version.py")
    with open(py_path, "w", encoding="utf-8") as f:
        f.write(f'# 自动生成，请勿手改。由 scripts/bump_build.py 在每次构建时写入。\n')
        f.write(f'VERSION = {version!r}\n')
        f.write(f'BUILD = {int(v["build"])}\n')

    # 2) version_info.txt —— PyInstaller VERSIONINFO（exe 右键属性里的版本）
    vi = f'''# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({full[0]}, {full[1]}, {full[2]}, {full[3]}),
    prodvers=({full[0]}, {full[1]}, {full[2]}, {full[3]}),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Subtitle-for-G'),
      StringStruct('FileDescription', 'Subtitle-for-G 字幕双语编辑器'),
      StringStruct('FileVersion', '{version}'),
      StringStruct('InternalName', 'Subtitle-for-G'),
      StringStruct('LegalCopyright', '(c) Subtitle-for-G'),
      StringStruct('OriginalFilename', 'Subtitle-for-G.exe'),
      StringStruct('ProductName', 'Subtitle-for-G'),
      StringStruct('ProductVersion', '{version}')
    ])]),
    VarFileInfo([VarStruct('Translation', [0x0409, 0x04B0])])
  ]
)
'''
    vi_path = os.path.join(BASE, "version_info.txt")
    with open(vi_path, "w", encoding="utf-8") as f:
        f.write(vi)

    print(version)


if __name__ == "__main__":
    main()
