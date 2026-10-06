import numpy as np
import pytest
from PIL import Image

from staging.imaging import (closest_aspect_ratio, load_image, plan_canvas, prepare_model_input,
                             restore_to_input)
from synthetic import draw_room


@pytest.mark.parametrize("size,ratio", [((1500, 1000), "3:2"), ((4032, 3024), "4:3"), ((1080, 1920), "9:16"),
                                        ((1000, 1000), "1:1"), ((1920, 1080), "16:9"), ((3000, 2000), "3:2")])
def test_closest_supported_ratio(size, ratio):
    assert closest_aspect_ratio(*size) == ratio


def test_square_model_output_is_restored_to_exact_input_size():
    canvas = plan_canvas(1500, 1000)
    out = restore_to_input(Image.new("RGB", (1024, 1024), "white"), canvas)
    assert out.size == (1500, 1000)


@pytest.mark.parametrize("size", [(1500, 1000), (1200, 900), (900, 1600), (1600, 1000), (2000, 700), (1000, 1000)])
def test_identity_edit_round_trip_preserves_size_and_content(size):
    img = draw_room(size)
    canvas = plan_canvas(*size)
    model_in = prepare_model_input(img, canvas, max_side=1024)
    assert max(model_in.size) <= 1024 or canvas.padded
    # simulate a model returning the same picture at its own native resolution
    native = model_in.resize((model_in.width * 3 // 4, model_in.height * 3 // 4))
    out = restore_to_input(native, canvas)
    assert out.size == size
    diff = np.abs(np.asarray(out, float) - np.asarray(img, float)).mean()
    assert diff < 12, diff


def test_far_off_ratio_is_padded_and_cropped_back():
    canvas = plan_canvas(2000, 700)   # ~2.86:1, closest supported is 21:9
    assert canvas.aspect_ratio == "21:9" and canvas.padded
    x0, y0, x1, y1 = canvas.content_box
    assert x0 == 0 and y0 > 0 and y1 < 1


def test_pad_only_when_ratio_is_more_than_4_percent_off():
    assert not plan_canvas(1536, 1000).padded   # 1.536 vs 3:2: 2.4% off, stretched back invisibly
    assert plan_canvas(1600, 1000).padded       # 1.6 vs 3:2: 6.7% off


def test_load_image_applies_exif_orientation(tmp_path):
    img = Image.new("RGB", (40, 20), "red")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 CW on display
    p = tmp_path / "rot.jpg"
    img.save(p, exif=exif)
    assert load_image(p).size == (20, 40)
