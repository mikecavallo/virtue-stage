import itertools

import pytest

from staging.analysis import ROOM_TYPES
from staging.planner import build_plan, choose_wall, validate_plan
from staging.styles import STYLE_KEYS, STYLES
from synthetic import room_analysis


def el(t, wall, desc=None):
    return {"type": t, "description": desc or t, "wall": wall, "bbox": None}


def ids(plan):
    return [p["id"] for p in plan["pieces"]]


def test_every_style_has_all_piece_categories():
    cats = set(STYLES["modern"]["pieces"])
    for key in STYLE_KEYS:
        assert set(STYLES[key]["pieces"]) == cats, key
        assert STYLES[key]["avoid"], key
    assert {"coastal", "farmhouse"} <= set(STYLE_KEYS)


def test_small_living_room_gets_fewer_smaller_pieces_than_large():
    small = build_plan(room_analysis(size_class="small"), "modern")
    large = build_plan(room_analysis(size_class="large"), "modern")
    assert len(small["pieces"]) < len(large["pieces"])
    assert "accent_chair" not in ids(small) and "accent_chair" in ids(large)
    sofa_small = next(p for p in small["pieces"] if p["id"] == "sofa")
    assert "apartment-size" in sofa_small["size"]
    assert small["rug"]["size"] == "5x8 ft" and large["rug"]["size"] == "9x12 ft"


def test_studio_is_always_planned_as_small():
    plan = build_plan(room_analysis(room_type="studio", size_class="large"), "modern", "studio")
    assert plan["size_class"] == "small"


@pytest.mark.parametrize("room_type,style", list(itertools.product(ROOM_TYPES, STYLE_KEYS)))
def test_generated_plans_never_put_wall_pieces_on_door_or_window_walls(room_type, style):
    analysis = room_analysis(room_type=room_type, fixed=[
        el("door", "right"), el("window", "back"), el("vent", "floor"), el("radiator", "left")])
    for size in ("small", "medium", "large"):
        analysis["size_class"] = size
        plan = build_plan(analysis, style, room_type)
        assert validate_plan(plan, analysis) == []
        for p in plan["pieces"]:
            assert p["wall"] != "right", p  # door wall
            assert p["wall"] != "left", p   # radiator wall


def test_bed_goes_on_solid_headwall_not_window_or_door_wall():
    analysis = room_analysis(room_type="bedroom", fixed=[el("window", "back"), el("door", "right")])
    plan = build_plan(analysis, "scandinavian", "bedroom")
    bed = next(p for p in plan["pieces"] if p["id"] == "bed")
    assert bed["wall"] == "left"
    art = next(p for p in plan["pieces"] if p["id"] == "art")
    assert art["wall"] == "left", "art hangs above the headboard"


def test_medium_bedroom_drops_dresser_rather_than_crowding_the_headwall():
    analysis = room_analysis(room_type="bedroom", fixed=[el("window", "back"), el("door", "right")])
    plan = build_plan(analysis, "modern", "bedroom")
    assert "dresser" not in ids(plan)
    assert any("dresser" in o for o in plan["omitted"])


def test_all_walls_blocked_makes_pieces_free_standing():
    analysis = room_analysis(room_type="bedroom", fixed=[el("door", "left"), el("doorway", "back"), el("closet", "right")])
    plan = build_plan(analysis, "modern", "bedroom")
    bed = next(p for p in plan["pieces"] if p["id"] == "bed")
    assert bed["wall"] is None and bed["anchor"] == "float"
    assert "free-standing" in bed["placement"] and "36 in" in bed["placement"]


def test_low_pieces_may_sit_under_windows_but_tall_ones_may_not():
    analysis = room_analysis(fixed=[el("window", "back"), el("window", "left"), el("door", "right")])
    assert choose_wall(analysis, "low", {}) in ("back", "left")
    assert choose_wall(analysis, "tall", {}) is None


def test_keep_clear_lists_doors_windows_vents_and_paths():
    analysis = room_analysis(fixed=[el("door", "right", "hall door"), el("window", "back", "bay window"),
                                    el("vent", "floor", "floor register")])
    plan = build_plan(analysis, "modern")
    text = " | ".join(plan["keep_clear"])
    assert "hall door" in text and "36 in" in text
    assert "bay window" in text and "do not block" in text
    assert "floor register" in text and "uncovered" in text
    assert "never over a floor vent" in plan["rug"]["rule"]


@pytest.mark.parametrize("size,expect", [("small", "seats 4"), ("medium", "seats 6"), ("large", "seats 8")])
def test_dining_table_scales_with_room(size, expect):
    plan = build_plan(room_analysis(room_type="dining-room", size_class=size), "traditional", "dining-room")
    table = next(p for p in plan["pieces"] if p["id"] == "dining_table")
    assert expect in table["size"]
    assert "36 in clearance" in table["placement"]
    assert (plan["rug"] is None) == (size == "small")


def test_kitchen_is_minimal_and_only_gets_stools_with_an_island():
    no_island = build_plan(room_analysis(room_type="kitchen", fixed=[]), "modern", "kitchen")
    assert ids(no_island) == ["kitchen_accents"]
    assert no_island["styling_level"] == "minimal" and no_island["rug"] is None
    island = build_plan(room_analysis(room_type="kitchen", fixed=[el("cabinetry", None, "center island with overhang")]),
                        "modern", "kitchen")
    assert "bar_stool" in ids(island)


def test_bathroom_is_accessories_only():
    plan = build_plan(room_analysis(room_type="bathroom", fixed=[]), "luxury", "bathroom")
    assert ids(plan) == ["bath_accents"]
    assert plan["styling_level"] == "accessories_only"


def test_patio_uses_outdoor_pieces():
    plan = build_plan(room_analysis(room_type="patio", size_class="large", fixed=[]), "coastal", "patio")
    assert {"outdoor_seating", "outdoor_table", "outdoor_accents"} <= set(ids(plan))


def test_reference_plan_reuses_the_same_pieces_without_camera_walls():
    hero = build_plan(room_analysis(size_class="large"), "coastal")
    second_view = room_analysis(size_class="small", fixed=[el("door", "back")])
    plan = build_plan(second_view, "coastal", reference_plan=hero)
    assert [p["description"] for p in plan["pieces"]] == [p["description"] for p in hero["pieces"]]
    assert all(p["wall"] is None for p in plan["pieces"])
    assert plan["rug"] == hero["rug"]
    assert plan["consistency"] and "identical" in plan["consistency"]["rule"]
