"""生成 GIF 真实样本（Pillow 编码），供 tools/gen-fixtures.mjs 寄存器使用。

为什么 GIF 要借 Pillow 而不是像 PNG/BMP/JPEG 那样自己写编码器：
  手写 GIF LZW 有两大坑（位序 LSB、字典满时码长 +1），本项目的自写实现被
  Chromium（"The source image could not be decoded"）与 Pillow
  （"image file is truncated"）同时拒收；退回「改写真实模板的宽高字段」
  也被拒 —— GIF 解码器会交叉校验像素流长度与声明的图像尺寸。
  结论：GIF 素材直接用真实编码器产出，最省事也最可信。

用法（本机 Python，Pillow 已在 DSH 运行时里）：
  python tools/make-gif-template.py

产物：tests/samples/gif-120x90.gif
"""

from __future__ import annotations

import pathlib
import sys

# 本机 DSH 运行时的 Python 与 site-packages（Pillow 在此）
DSH_PY = pathlib.Path(r"C:\Users\Lizhuo\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python")
for extra in (DSH_PY / "Lib" / "site-packages", DSH_PY):
    if extra.is_dir() and str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

try:
    from PIL import Image  # noqa: E402
except ImportError as exc:  # pragma: no cover - 环境缺失时给出可读提示
    sys.exit(f"缺少 Pillow：{exc}. 请在本机 DSH 运行时的 Python 下执行本脚本。")

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "tests" / "samples"

# 与 fixtures 里期望的尺寸一致：左上 1/4 为亮色，其余暗色，便于缩略图断言
WIDTH, HEIGHT = 120, 90
BG = (32, 32, 32)
FG = (200, 40, 40)


def main() -> int:
    img = Image.new("P", (WIDTH, HEIGHT))
    # 3 色调色板：背景 / 前景 / 填充位
    img.putpalette([0, 0, 0, 200, 40, 40, 32, 32, 32])
    px = img.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            px[x, y] = 1 if (x < WIDTH // 4 and y < HEIGHT // 4) else 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dst = OUT_DIR / f"gif-{WIDTH}x{HEIGHT}.gif"
    img.save(dst, format="GIF", optimize=False)

    # 自检：读回来尺寸必须一致，否则素材本身就是坏的
    with Image.open(dst) as back:
        back.load()
        if back.size != (WIDTH, HEIGHT):
            sys.exit(f"自检失败：{dst} 读回 {back.size}，期望 {(WIDTH, HEIGHT)}")
        print(f"OK  {dst.relative_to(REPO)}  {dst.stat().st_size} bytes  {back.size}  {back.format}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
