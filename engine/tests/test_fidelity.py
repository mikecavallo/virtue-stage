from PIL import ImageChops, ImageDraw

from staging.fidelity import preserve_regions, ssim, structural_fidelity
from synthetic import add_furniture, alter_window, draw_room, regenerate, room_analysis

import numpy as np


def window_region(result):
    return next(r for r in result["regions"] if r["name"].startswith("window"))


def test_ssim_identity_is_one():
    a = np.random.default_rng(0).integers(0, 255, (40, 50)).astype(float)
    assert abs(ssim(a, a) - 1) < 1e-9


def test_regions_come_from_analysis_and_skip_lower_part_of_windows():
    regions = preserve_regions(room_analysis())
    names = [r["name"] for r in regions]
    assert names[0].startswith("top band")
    win = next(r for r in regions if r["name"].startswith("window"))
    assert win["box"][3] < 0.5  # only the upper 60% of the window box


def test_adding_furniture_passes_but_moving_a_window_fails():
    original = draw_room()
    analysis = room_analysis()
    staged = regenerate(add_furniture(original), seed=2)
    drifted = regenerate(alter_window(add_furniture(original)), seed=3)

    ok = structural_fidelity(original, staged, analysis)
    bad = structural_fidelity(original, drifted, analysis)

    assert ok["passed"], ok
    assert not bad["passed"], bad
    assert any(n.startswith("window") for n in bad["failed_regions"])
    assert window_region(bad)["score"] < window_region(ok)["score"] - 0.3
    assert ok["score"] > bad["score"]


def test_recolored_ceiling_and_walls_fail():
    original = draw_room()
    out = add_furniture(original)
    d = ImageDraw.Draw(out)
    d.rectangle([0, 0, out.width, out.height * 0.2], fill=(90, 120, 160))
    res = structural_fidelity(original, regenerate(out), room_analysis())
    assert not res["passed"]
    assert any(n.startswith("top band") for n in res["failed_regions"])


def test_small_reframing_shift_is_tolerated_and_reported():
    original = draw_room()
    shifted = ImageChops.offset(regenerate(add_furniture(original)), 6, 4)
    res = structural_fidelity(original, shifted, room_analysis())
    assert res["passed"]
    assert res["shift_px"] != [0, 0]


def test_works_without_analysis_using_top_band_only():
    original = draw_room()
    res = structural_fidelity(original, regenerate(add_furniture(original)), None)
    assert len(res["regions"]) == 1 and res["passed"]
