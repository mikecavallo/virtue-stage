"""Synthetic room images for tests: a one-point-perspective room drawn with PIL."""

import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

WALL = (226, 220, 208)
SIDE_WALL = (210, 203, 190)
CEILING = (240, 238, 232)
FLOOR = (176, 140, 102)
FRAME = (250, 250, 250)
GLASS = (160, 190, 215)
DOOR = (120, 92, 66)

# Normalized geometry (x0, y0, x1, y1).
BACK_WALL = (0.22, 0.18, 0.78, 0.66)
WINDOW = (0.38, 0.26, 0.62, 0.5)
DOOR_BOX = (0.84, 0.2, 0.95, 0.8)


def _px(box, w, h):
    return [box[0] * w, box[1] * h, box[2] * w, box[3] * h]


def draw_room(size=(960, 640), seed=0) -> Image.Image:
    w, h = size
    img = Image.new("RGB", size, CEILING)
    d = ImageDraw.Draw(img)
    bx0, by0, bx1, by1 = _px(BACK_WALL, w, h)
    # floor, side walls, back wall
    d.polygon([(0, h), (w, h), (bx1, by1), (bx0, by1)], fill=FLOOR)
    d.polygon([(0, 0), (bx0, by0), (bx0, by1), (0, h)], fill=SIDE_WALL)
    d.polygon([(w, 0), (bx1, by0), (bx1, by1), (w, h)], fill=SIDE_WALL)
    d.rectangle([bx0, by0, bx1, by1], fill=WALL)
    # crown/edges
    for line in [((0, 0), (bx0, by0)), ((w, 0), (bx1, by0)), ((bx0, by0), (bx1, by0)), ((0, h), (bx0, by1)), ((w, h), (bx1, by1))]:
        d.line(line, fill=(150, 140, 125), width=2)
    # ceiling light fixture
    d.ellipse([w * 0.46, h * 0.04, w * 0.54, h * 0.09], fill=(250, 245, 225), outline=(140, 130, 110), width=2)
    # floor boards
    rng = random.Random(seed)
    for i in range(1, 14):
        x = i * w / 14
        d.line([(x, h), (bx0 + (bx1 - bx0) * i / 14, by1)], fill=(150, 118, 84), width=1)
    # window with mullions
    wx0, wy0, wx1, wy1 = _px(WINDOW, w, h)
    d.rectangle([wx0, wy0, wx1, wy1], fill=FRAME)
    m = 8
    d.rectangle([wx0 + m, wy0 + m, wx1 - m, wy1 - m], fill=GLASS)
    d.line([((wx0 + wx1) / 2, wy0), ((wx0 + wx1) / 2, wy1)], fill=FRAME, width=6)
    d.line([(wx0, (wy0 + wy1) / 2), (wx1, (wy0 + wy1) / 2)], fill=FRAME, width=6)
    # door on right wall
    dx0, dy0, dx1, dy1 = _px(DOOR_BOX, w, h)
    d.polygon([(dx0, dy0 + 10), (dx1, dy0), (dx1, dy1), (dx0, dy1 - 10)], fill=DOOR)
    d.ellipse([dx0 + 8, (dy0 + dy1) / 2, dx0 + 16, (dy0 + dy1) / 2 + 8], fill=(200, 180, 90))
    # mild texture noise so SSIM is not computed on perfectly flat color
    arr = np.asarray(img, dtype=np.int16)
    arr = arr + np.random.default_rng(seed).integers(-3, 4, arr.shape)
    _ = rng
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def room_analysis(room_type="living-room", size_class="medium", fixed=None):
    return {
        "room_type": room_type,
        "room_type_confidence": 0.9,
        "is_interior": True,
        "occupancy": "empty",
        "existing_items": [],
        "camera": {"height": "eye_level", "angle": "straight_on", "pitch": "level", "lens": "wide",
                   "vanishing_direction": "center"},
        "lighting": {"primary_source": "window on back wall", "direction": "from the back toward the camera",
                     "color_temperature": "neutral", "kelvin_estimate": 5200, "time_of_day": "midday",
                     "shadow_softness": "soft", "sources": []},
        "fixed_elements": fixed if fixed is not None else [
            {"type": "window", "description": "white double window", "wall": "back", "bbox": list(WINDOW)},
            {"type": "door", "description": "wood door", "wall": "right", "bbox": list(DOOR_BOX)},
            {"type": "ceiling_fixture", "description": "flush mount light", "wall": "ceiling",
             "bbox": [0.46, 0.04, 0.54, 0.09]},
        ],
        "flooring": {"material": "oak hardwood", "color": "medium oak"},
        "walls": {"color": "warm white", "finish": "matte"},
        "ceiling": {"type": "flat", "height": "standard", "fixtures": ["flush mount light"]},
        "walkable_floor_bbox": [0.05, 0.66, 0.95, 1.0],
        "traffic_paths": ["from the right door to the window"],
        "size_class": size_class,
        "approx_floor_area_sqft": None,
        "notes": "",
        "source": "model",
    }


def regenerate(img: Image.Image, seed=1, noise=6, blur=0.8, quality=80) -> Image.Image:
    """Simulate an image model re-rendering the whole frame: blur, noise, JPEG."""
    import io
    out = img.filter(ImageFilter.GaussianBlur(blur))
    arr = np.asarray(out, dtype=np.int16) + np.random.default_rng(seed).normal(0, noise, (img.height, img.width, 3)).astype(np.int16)
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def add_furniture(img: Image.Image) -> Image.Image:
    """Objects in the lower half only (what staging should do)."""
    out = img.copy()
    w, h = out.size
    d = ImageDraw.Draw(out)
    d.rectangle([w * 0.15, h * 0.88, w * 0.75, h * 0.98], fill=(222, 214, 200))          # rug
    d.rectangle([w * 0.25, h * 0.6, w * 0.65, h * 0.82], fill=(200, 190, 175))           # sofa body
    d.rectangle([w * 0.25, h * 0.52, w * 0.65, h * 0.62], fill=(185, 175, 160))          # sofa back (overlaps lower window region)
    d.rectangle([w * 0.35, h * 0.84, w * 0.55, h * 0.9], fill=(120, 95, 70))             # coffee table
    d.ellipse([w * 0.08, h * 0.55, w * 0.16, h * 0.8], fill=(70, 110, 60))                # plant
    return out


def alter_window(img: Image.Image) -> Image.Image:
    """Architecture drift: window painted over and a different window drawn elsewhere."""
    out = img.copy()
    w, h = out.size
    d = ImageDraw.Draw(out)
    wx0, wy0, wx1, wy1 = _px(WINDOW, w, h)
    d.rectangle([wx0 - 2, wy0 - 2, wx1 + 2, wy1 + 2], fill=WALL)
    d.rectangle([w * 0.25, h * 0.24, w * 0.34, h * 0.48], fill=FRAME)
    d.rectangle([w * 0.255, h * 0.25, w * 0.335, h * 0.47], fill=GLASS)
    return out
