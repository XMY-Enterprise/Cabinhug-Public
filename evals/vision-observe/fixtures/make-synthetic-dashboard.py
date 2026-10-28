"""生成 vision-node 单测用的合成仪表图（纯色块，自制）。

按 `by-sha/` 里那份整图观察 fixture 的 8 个框，在 2000×1333 的浅灰底上画同色色块：
读数与车轮廓画深灰（代码定色把黑并入灰），点亮的灯画高饱和的绿 / 红，未点亮的画中灰。
像素定色只看框内高饱和像素的色相，色块足以复现 fixture 里的颜色。

用法：python3 make-synthetic-dashboard.py，随后按新图 sha256 前 8 位更新 by-sha/ 下的文件名。
"""

from pathlib import Path

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 2000, 1333
BACKGROUND = (236, 237, 239)
FILL = {"black": (40, 40, 44), "gray": (150, 150, 152), "green": (30, 190, 90), "red": (225, 35, 35)}

# (bbox 0–1000 归一化, 颜色, 形状)：与 by-sha fixture 的 items 逐项对应。
ITEMS = [
    ([456, 120, 532, 150], "black", "bar"),
    ([578, 120, 618, 150], "black", "bar"),
    ([642, 122, 772, 152], "gray", "bar"),
    ([552, 195, 594, 238], "green", "lamp"),
    ([552, 280, 594, 322], "gray", "lamp"),
    ([552, 362, 598, 398], "green", "lamp"),
    ([562, 435, 596, 485], "red", "lamp"),
    ([468, 452, 508, 565], "black", "outline"),
]


def to_pixels(box: list[int]) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    return (x1 * WIDTH // 1000, y1 * HEIGHT // 1000, x2 * WIDTH // 1000, y2 * HEIGHT // 1000)


def main() -> None:
    image = Image.new("RGB", (WIDTH, HEIGHT), BACKGROUND)
    draw = ImageDraw.Draw(image)
    for box, color, shape in ITEMS:
        x1, y1, x2, y2 = to_pixels(box)
        inset = (x2 - x1) // 6
        if shape == "lamp":
            draw.ellipse((x1 + inset, y1 + inset, x2 - inset, y2 - inset), fill=FILL[color])
        elif shape == "outline":
            draw.rectangle((x1 + inset, y1 + inset, x2 - inset, y2 - inset), outline=FILL[color], width=6)
        else:
            draw.rectangle((x1, y1 + (y2 - y1) // 4, x2, y2 - (y2 - y1) // 4), fill=FILL[color])
    image.save(Path(__file__).with_name("synthetic-dashboard.png"), optimize=True)


if __name__ == "__main__":
    main()
