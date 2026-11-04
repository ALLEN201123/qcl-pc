"""把 QCL 的 glTF 模型从「内嵌 base64 buffer」改成「外置 .bin + 外置贴图」。

为什么：
  1. 内嵌 base64 让每个 .gltf 变成 128KB 的巨型单行文本。一旦渲染层有任何「把文本显示出来」
     的路径出错（比如错误信息、日志面板），屏幕上就会刷出几十万字符的 base64 —— 用户看到的
     就是满屏乱码。拆成独立 .bin 后，.gltf 只剩可读的 JSON（约 20KB）。
  2. 贴图 uri 也要指向真实存在的文件：slim 模型引用 `sunny.png`（安卓版资源里没有这个文件），
     直接改成 `alex.png`，否则一个 404 会让整个模型加载失败。

用法：python build/split-gltf.py
"""

import base64
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKIN_DIR = os.path.join(ROOT, "src", "renderer", "assets", "skin_model")

# 模型名 -> (外置 bin 文件名, 贴图替换表)
MODELS = {
    "classic-player.gltf": ("classic-player.bin", {"steve.png": "steve.png", "cape": "cape"}),
    "slim-player.gltf": ("slim-player.bin", {"sunny.png": "alex.png", "cape": "cape"}),
}


def split_one(fname, bin_name, image_map):
    path = os.path.join(SKIN_DIR, fname)
    with open(path, "r", encoding="utf-8") as f:
        gltf = json.load(f)

    changed = []

    # 1. 内嵌 buffer -> 外置 .bin
    for buf in gltf.get("buffers", []):
        uri = buf.get("uri", "")
        if uri.startswith("data:"):
            payload = uri.split(",", 1)[1]
            raw = base64.b64decode(payload)
            bin_path = os.path.join(SKIN_DIR, bin_name)
            with open(bin_path, "wb") as f:
                f.write(raw)
            buf["uri"] = bin_name
            changed.append(f"buffer -> {bin_name} ({len(raw)} bytes)")

    # 2. 贴图 uri 指向真实文件
    for img in gltf.get("images", []):
        old = img.get("uri")
        if old in image_map and image_map[old] != old:
            img["uri"] = image_map[old]
            changed.append(f"texture {old} -> {image_map[old]}")

    with open(path, "w", encoding="utf-8") as f:
        json.dump(gltf, f, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(path)
    print(f"{fname}: {size / 1024:.1f} KB")
    for c in changed:
        print(f"   {c}")


def ensure_texture():
    """确保 slim 模型用的贴图存在（alex.png 必须和 gltf 同目录）。"""
    for name in ("steve.png", "alex.png"):
        dst = os.path.join(SKIN_DIR, name)
        if not os.path.exists(dst):
            print(f"⚠ 缺少贴图 {name}")
        else:
            print(f"贴图 {name}: {os.path.getsize(dst)} bytes")


def main():
    print(f"模型目录：{SKIN_DIR}")
    ensure_texture()
    for fname, (bin_name, image_map) in MODELS.items():
        split_one(fname, bin_name, image_map)
    print("完成")


if __name__ == "__main__":
    main()
