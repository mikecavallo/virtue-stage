import json

import virtual_stager
from synthetic import draw_room


def test_cli_contract_with_fake_provider(tmp_path, monkeypatch):
    monkeypatch.setenv("VIRTUESTAGE_PROVIDER", "fake")
    src = tmp_path / "room.jpg"
    draw_room((1200, 800)).save(src)
    assert virtual_stager.main([str(src), "--style", "coastal", "--room-type", "living-room"]) == 0
    out = tmp_path / "room_staged_coastal_fake.jpg"
    meta = json.loads((tmp_path / "room_staged_coastal_fake.json").read_text())
    from PIL import Image
    assert Image.open(out).size == (1200, 800)
    assert meta["plan"]["style"] == "coastal" and meta["quality"]["passed"]

    # second angle: reference image + reference plan from the hero metadata
    src2 = tmp_path / "angle2.jpg"
    draw_room((1000, 750), seed=4).save(src2)
    rc = virtual_stager.main([str(src2), "--style", "coastal", "--reference-image", str(out),
                              "--reference-plan", str(tmp_path / "room_staged_coastal_fake.json"), "--candidates", "1"])
    assert rc == 0
    meta2 = json.loads((tmp_path / "angle2_staged_coastal_fake.json").read_text())
    assert meta2["settings"]["reference_image"] and meta2["settings"]["reference_plan"]
    assert [p["description"] for p in meta2["plan"]["pieces"]] == [p["description"] for p in meta["plan"]["pieces"]]


def test_cli_missing_file_and_missing_key(tmp_path, monkeypatch):
    assert virtual_stager.main([str(tmp_path / "nope.jpg")]) == 1
    monkeypatch.delenv("VIRTUESTAGE_PROVIDER", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    src = tmp_path / "room.jpg"
    draw_room((300, 200)).save(src)
    assert virtual_stager.main([str(src)]) == 1
