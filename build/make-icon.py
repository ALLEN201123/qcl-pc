"""从 build/icon.png 生成多尺寸 build/icon.ico（Windows 需要 .ico 才能设图标）。"""
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：python -m pip install pillow")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "icon.png")
DST = os.path.join(HERE, "icon.ico")

SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

def main():
    if not os.path.exists(SRC):
        print(f"缺少源图：{SRC}")
        return 1
    img = Image.open(SRC).convert("RGBA")
    # 生成方图（原图不是方图时居中裁切）
    w, h = img.size
    if w != h:
        side = min(w, h)
        img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    img.save(DST, format="ICO", sizes=SIZES)
    print(f"已生成 {DST}（{os.path.getsize(DST) / 1024:.1f} KB，尺寸 {SIZES}）")
    return 0

if __name__ == "__main__":
    sys.exit(main())
