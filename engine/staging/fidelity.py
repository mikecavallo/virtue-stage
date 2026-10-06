"""Step 5a: structural fidelity, i.e. did the architecture survive the edit?

Compares input and output only in regions that staging should never touch:
- the top band of the frame (ceiling, upper walls, crown molding, fixtures);
- every window/door/fireplace/built-in box from the analysis (upper part only,
  since furniture may legitimately sit in front of the lower part).

Per region it measures SSIM, edge-map agreement (F1 with 1 px tolerance) and
mean color shift, after a small translation search so a model that shifts the
frame by a few pixels is not punished as harshly as one that redraws a window.
Pure numpy + Pillow. Thresholds are starting points, not calibrated on real
model output yet; ``python -m eval.run`` reports raw numbers for calibration.
"""

from typing import List, Optional, Tuple

import numpy as np
from PIL import Image

WORK_WIDTH = 384
TOP_BAND = 0.2
REGION_TYPES = {"window": 1.5, "door": 1.2, "doorway": 1.2, "sliding_door": 1.5, "fireplace": 1.5,
                "built_in": 1.0, "ceiling_fixture": 1.0, "ceiling_fan": 1.0, "closet": 1.0, "cabinetry": 1.0,
                "stairs": 1.0, "radiator": 0.8}
DEFAULT_THRESHOLDS = {"overall": 0.6, "min_region": 0.45}


def _to_gray(img: Image.Image, size: Tuple[int, int]) -> np.ndarray:
    return np.asarray(img.convert("L").resize(size, Image.BILINEAR), dtype=np.float64)


def _to_rgb(img: Image.Image, size: Tuple[int, int]) -> np.ndarray:
    return np.asarray(img.convert("RGB").resize(size, Image.BILINEAR), dtype=np.float64)


def _box_mean(a: np.ndarray, k: int) -> np.ndarray:
    """Mean over a k x k window (valid region), via integral image."""
    c = np.pad(a, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def ssim(a: np.ndarray, b: np.ndarray, k: int = 7) -> float:
    if min(a.shape) < k:
        return float(1.0 - min(1.0, np.abs(a - b).mean() / 64))
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = _box_mean(a, k), _box_mean(b, k)
    va = _box_mean(a * a, k) - mu_a ** 2
    vb = _box_mean(b * b, k) - mu_b ** 2
    cov = _box_mean(a * b, k) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2))
    return float(s.mean())


def sobel_magnitude(g: np.ndarray) -> np.ndarray:
    p = np.pad(g, 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return np.hypot(gx, gy)


def _dilate(m: np.ndarray, r: int = 1) -> np.ndarray:
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def edge_f1(ea: np.ndarray, eb: np.ndarray) -> float:
    na, nb = int(ea.sum()), int(eb.sum())
    if na < 5 and nb < 5:
        return 1.0  # featureless region on both sides (blank wall)
    if na == 0 or nb == 0:
        return 0.0
    precision = (eb & _dilate(ea)).sum() / nb
    recall = (ea & _dilate(eb)).sum() / na
    return float(0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall))


def _shift(a: np.ndarray, dx: int, dy: int) -> np.ndarray:
    return np.roll(np.roll(a, dy, 0), dx, 1)


def estimate_shift(ga: np.ndarray, gb: np.ndarray, max_frac: float = 0.03) -> Tuple[int, int]:
    """Integer (dx, dy) that best aligns b to a, searched on the upper half (least furniture)."""
    h, w = ga.shape
    r = max(1, int(round(max(w, h) * max_frac)))
    ya, yb = ga[: h // 2], gb[: h // 2]
    ea, eb = sobel_magnitude(ya), sobel_magnitude(yb)
    best, best_err = (0, 0), None
    m = r
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            sb = _shift(eb, dx, dy)
            err = np.abs(ea[m:-m, m:-m] - sb[m:-m, m:-m]).mean()
            if best_err is None or err < best_err - 1e-9 or (abs(err - best_err) <= 1e-9 and abs(dx) + abs(dy) < abs(best[0]) + abs(best[1])):
                best, best_err = (dx, dy), err
    return best


def preserve_regions(analysis: Optional[dict]) -> List[dict]:
    regions = [{"name": "top band (ceiling / upper walls)", "box": [0.0, 0.0, 1.0, TOP_BAND], "weight": 1.0}]
    for el in (analysis or {}).get("fixed_elements", []):
        box = el.get("bbox")
        weight = REGION_TYPES.get(el.get("type"))
        if not box or weight is None:
            continue
        x0, y0, x1, y1 = box
        if (x1 - x0) * (y1 - y0) < 0.004:
            continue
        if el["type"] not in ("ceiling_fixture", "ceiling_fan"):
            y1 = y0 + (y1 - y0) * 0.6  # lower part may be legitimately behind furniture
        regions.append({"name": f"{el['type']}: {el.get('description', '')}"[:80], "box": [x0, y0, x1, y1],
                        "weight": weight, "type": el["type"]})
    return regions


def structural_fidelity(original: Image.Image, output: Image.Image, analysis: Optional[dict] = None,
                        thresholds: Optional[dict] = None) -> dict:
    th = dict(DEFAULT_THRESHOLDS, **(thresholds or {}))
    w0, h0 = original.size
    size = (WORK_WIDTH, max(8, round(WORK_WIDTH * h0 / w0)))
    ga, gb = _to_gray(original, size), _to_gray(output, size)
    ca, cb = _to_rgb(original, size), _to_rgb(output, size)
    dx, dy = estimate_shift(ga, gb)
    gb, cb = _shift(gb, dx, dy), _shift(cb, dx, dy)

    mag_a, mag_b = sobel_magnitude(ga), sobel_magnitude(gb)
    thr = max(40.0, float(np.percentile(mag_a, 85)))
    ea, eb = mag_a > thr, mag_b > thr

    W, H = size
    results, total, wsum = [], 0.0, 0.0
    margin = max(abs(dx), abs(dy))
    for reg in preserve_regions(analysis):
        x0, y0, x1, y1 = reg["box"]
        X0, Y0 = int(x0 * W), int(y0 * H)
        X1, Y1 = max(X0 + 2, int(round(x1 * W))), max(Y0 + 2, int(round(y1 * H)))
        # Exclude the wrapped-around border introduced by the shift.
        X0, Y0 = max(X0, margin), max(Y0, margin)
        X1, Y1 = min(X1, W - margin), min(Y1, H - margin)
        if X1 - X0 < 3 or Y1 - Y0 < 3:
            continue
        sa, sb = ga[Y0:Y1, X0:X1], gb[Y0:Y1, X0:X1]
        s = max(0.0, ssim(sa, sb))
        f1 = edge_f1(ea[Y0:Y1, X0:X1], eb[Y0:Y1, X0:X1])
        color_delta = float(np.abs(ca[Y0:Y1, X0:X1].mean((0, 1)) - cb[Y0:Y1, X0:X1].mean((0, 1))).mean() / 255)
        color_score = 1.0 - min(1.0, color_delta / 0.15)
        score = 0.45 * s + 0.4 * f1 + 0.15 * color_score
        results.append({"name": reg["name"], "box": [round(v, 3) for v in reg["box"]], "ssim": round(s, 3),
                        "edge_f1": round(f1, 3), "color_delta": round(color_delta, 3), "score": round(score, 3)})
        total += score * reg["weight"]
        wsum += reg["weight"]
    overall = total / wsum if wsum else 1.0
    worst = min((r["score"] for r in results), default=1.0)
    failed = [r["name"] for r in results if r["score"] < th["min_region"]]
    return {
        "score": round(overall, 3),
        "min_region": round(worst, 3),
        "passed": overall >= th["overall"] and worst >= th["min_region"],
        "failed_regions": failed,
        "shift_px": [dx, dy],
        "shift_frac": [round(dx / W, 4), round(dy / H, 4)],
        "regions": results,
        "thresholds": th,
    }
