import numpy as np
from PIL import Image

from staging.watermark import add_disclosure, label_box


def test_label_is_drawn_in_corner_only():
    img = Image.new("RGB", (1200, 800), (230, 230, 230))
    out = add_disclosure(img)
    assert out.size == img.size
    diff = np.abs(np.asarray(out, int) - np.asarray(img, int)).sum(axis=2) > 0
    ys, xs = np.nonzero(diff)
    (x0, y0, x1, y1), *_ = label_box(img.size)
    assert xs.min() >= x0 and xs.max() <= x1 and ys.min() >= y0 and ys.max() <= y1
    assert x0 < 1200 * 0.1 and y1 > 800 * 0.9  # bottom-left
    # dark label background with light text
    region = np.asarray(out, int)[y0:y1, x0:x1]
    assert region.mean() < 150 and region.max() > 200


def test_label_scales_with_image_and_supports_other_corners():
    small, *_ = label_box((400, 300))
    big, *_ = label_box((4000, 3000))
    assert (big[3] - big[1]) > 5 * (small[3] - small[1])
    (x0, y0, x1, y1), *_ = label_box((1000, 1000), position="top-right")
    assert x1 > 900 and y0 < 100
