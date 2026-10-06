"""Disclosure label for virtually staged photos.

Many MLSs, and NAR guidance, require virtually staged photos to be disclosed as
such. This draws a small, legible "Virtually Staged" label in a corner.
"""

from PIL import Image, ImageDraw, ImageFont

DEFAULT_TEXT = "Virtually Staged"
FONT_CANDIDATES = ("DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                   "Arial Bold.ttf", "arialbd.ttf", "Helvetica.ttc")


def _font(size: int):
    for name in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def label_box(size, text: str = DEFAULT_TEXT, position: str = "bottom-left", scale: float = 0.032):
    """(x0, y0, x1, y1) of the label for an image of ``size`` (also used by tests)."""
    w, h = size
    font_px = max(12, int(min(w, h) * scale * 1.25))
    font = _font(font_px)
    tb = ImageDraw.Draw(Image.new("RGB", (1, 1))).textbbox((0, 0), text, font=font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    pad = max(4, font_px // 2)
    margin = max(6, int(min(w, h) * 0.02))
    bw, bh = tw + 2 * pad, th + 2 * pad
    x0 = margin if "left" in position else w - margin - bw
    y0 = h - margin - bh if "bottom" in position else margin
    return (x0, y0, x0 + bw, y0 + bh), font, tb, pad


def add_disclosure(img: Image.Image, text: str = DEFAULT_TEXT, position: str = "bottom-left",
                   opacity: float = 0.72) -> Image.Image:
    base = img.convert("RGBA")
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    (x0, y0, x1, y1), font, tb, pad = label_box(base.size, text, position)
    d.rounded_rectangle([x0, y0, x1, y1], radius=pad, fill=(15, 23, 42, int(255 * opacity)))
    d.text((x0 + pad - tb[0], y0 + pad - tb[1]), text, font=font, fill=(255, 255, 255, 240))
    return Image.alpha_composite(base, overlay).convert("RGB")
