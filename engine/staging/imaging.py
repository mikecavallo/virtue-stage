"""Image helpers: loading, aspect-ratio handling and restoring model output to input size.

Image models return their own resolution and often their own aspect ratio
(square outputs from 3:2 photos were a known problem). The approach here:

1. Pick the supported aspect ratio closest to the input (sent to Gemini's
   ``image_config.aspect_ratio``).
2. If the input ratio is far from every supported ratio, pad the input with an
   edge-extended border up to that ratio and remember where the real photo sits.
3. After generation, cover-crop the output to the requested ratio (in case the
   model ignored it), crop the padding back off, and resize to the exact input
   width and height, so the before/after pair lines up pixel for pixel.
"""

import math
from dataclasses import dataclass
from typing import Tuple

from PIL import Image, ImageFilter, ImageOps

# Aspect ratios accepted by Gemini image models (image_config.aspect_ratio).
SUPPORTED_ASPECT_RATIOS = ("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9")

# Below this relative mismatch we stretch instead of padding: a <4% stretch is
# not visible and keeps the output aligned with the input for the compare slider.
PAD_THRESHOLD = 0.04


def ratio_value(ratio: str) -> float:
    w, h = ratio.split(":")
    return float(w) / float(h)


def load_image(path) -> Image.Image:
    """Open an image, apply EXIF orientation and convert to RGB."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def closest_aspect_ratio(width: int, height: int, supported=SUPPORTED_ASPECT_RATIOS) -> str:
    target = math.log(width / height)
    return min(supported, key=lambda r: abs(math.log(ratio_value(r)) - target))


@dataclass
class Canvas:
    """How the input was fitted onto the model canvas."""

    input_size: Tuple[int, int]
    aspect_ratio: str
    # Normalized box (x0, y0, x1, y1) of the real photo inside the padded canvas.
    content_box: Tuple[float, float, float, float] = (0.0, 0.0, 1.0, 1.0)

    @property
    def padded(self) -> bool:
        return self.content_box != (0.0, 0.0, 1.0, 1.0)

    def to_dict(self) -> dict:
        return {"input_size": list(self.input_size), "aspect_ratio": self.aspect_ratio,
                "content_box": [round(v, 4) for v in self.content_box], "padded": self.padded}


def plan_canvas(width: int, height: int) -> Canvas:
    ratio = closest_aspect_ratio(width, height)
    target = ratio_value(ratio)
    actual = width / height
    if abs(actual / target - 1) <= PAD_THRESHOLD:
        return Canvas((width, height), ratio)
    if actual > target:
        # Input is wider than the canvas: pad top and bottom.
        canvas_h = width / target
        pad = (canvas_h - height) / 2 / canvas_h
        box = (0.0, pad, 1.0, 1.0 - pad)
    else:
        canvas_w = height * target
        pad = (canvas_w - width) / 2 / canvas_w
        box = (pad, 0.0, 1.0 - pad, 1.0)
    return Canvas((width, height), ratio, box)


def prepare_model_input(img: Image.Image, canvas: Canvas, max_side: int = 1536) -> Image.Image:
    """Downscale (models re-render at ~1-2 MP anyway) and pad if the canvas needs it."""
    w, h = img.size
    scale = min(1.0, max_side / max(w, h))
    if scale < 1.0:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    if not canvas.padded:
        return img
    w, h = img.size
    x0, y0, x1, y1 = canvas.content_box
    cw = round(w / (x1 - x0))
    ch = round(h / (y1 - y0))
    left = (cw - w) // 2
    top = (ch - h) // 2
    # Edge-extend then blur the border so the model sees a neutral continuation
    # rather than hard black bars it might try to "fix".
    base = img.resize((cw, ch), Image.BILINEAR).filter(ImageFilter.GaussianBlur(radius=max(cw, ch) / 30))
    base.paste(img, (left, top))
    return base


def cover_crop_to_ratio(img: Image.Image, ratio: float) -> Image.Image:
    w, h = img.size
    actual = w / h
    if abs(actual / ratio - 1) < 1e-3:
        return img
    if actual > ratio:
        new_w = round(h * ratio)
        left = (w - new_w) // 2
        return img.crop((left, 0, left + new_w, h))
    new_h = round(w / ratio)
    top = (h - new_h) // 2
    return img.crop((0, top, w, top + new_h))


def restore_to_input(output: Image.Image, canvas: Canvas) -> Image.Image:
    """Map a model output back to the exact input size and framing."""
    out = output.convert("RGB")
    out = cover_crop_to_ratio(out, ratio_value(canvas.aspect_ratio))
    if canvas.padded:
        w, h = out.size
        x0, y0, x1, y1 = canvas.content_box
        out = out.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
    if out.size != tuple(canvas.input_size):
        out = out.resize(tuple(canvas.input_size), Image.LANCZOS)
    return out


def save_image(img: Image.Image, path, quality: int = 92) -> None:
    path = str(path)
    if path.lower().endswith((".jpg", ".jpeg")):
        img.convert("RGB").save(path, quality=quality, subsampling=0)
    else:
        img.save(path)


def aspect_mismatch(a: Tuple[int, int], b: Tuple[int, int]) -> float:
    """Relative aspect-ratio difference between two sizes (0 = identical)."""
    return abs((a[0] / a[1]) / (b[0] / b[1]) - 1)


def thumbnail(img: Image.Image, max_side: int) -> Image.Image:
    copy = img.copy()
    copy.thumbnail((max_side, max_side), Image.LANCZOS)
    return copy


__all__ = [
    "SUPPORTED_ASPECT_RATIOS", "Canvas", "aspect_mismatch", "closest_aspect_ratio", "cover_crop_to_ratio",
    "load_image", "plan_canvas", "prepare_model_input", "restore_to_input", "save_image", "thumbnail",
]

