from staging.planner import build_plan
from staging.prompts import MLS_RULES, build_declutter_prompt, build_render_prompt
from synthetic import room_analysis


def make(style="coastal", **kw):
    analysis = room_analysis()
    return build_render_prompt(build_plan(analysis, style), analysis, **kw), analysis


def test_prompt_has_explicit_preserve_list():
    prompt, _ = make()
    for phrase in ["KEEP IDENTICAL", "walls and wall color (warm white", "floor material", "oak hardwood",
                   "lighting fixture", "windows, window frames", "camera position, camera angle", "perspective",
                   "image framing and crop", "same aspect ratio", "white double window (back wall)",
                   "wood door (right wall)"]:
        assert phrase in prompt, phrase


def test_prompt_has_lighting_shadow_and_scale_instructions():
    prompt, _ = make()
    assert "window on back wall" in prompt and "5200K" in prompt
    assert "contact shadows" in prompt
    assert "doors are about 80 in tall" in prompt
    assert "photorealistic" in prompt and "not a 3D render" in prompt


def test_prompt_lists_plan_items_style_and_avoid_rules():
    prompt, _ = make("coastal")
    assert "Coastal style" in prompt
    assert "slipcovered white linen sofa" in prompt
    assert "nautical kitsch" in prompt
    for rule in MLS_RULES:
        assert rule in prompt
    assert "KEEP CLEAR" in prompt and "wood door" in prompt


def test_reference_and_feedback_sections_only_when_requested():
    plain, _ = make()
    assert "IMAGE 2" not in plain and "PREVIOUS ATTEMPT" not in plain
    ref, _ = make(has_reference=True, feedback="- The window changed.", custom_instructions="Use a blue rug.")
    assert "IMAGE 2 shows the SAME room" in ref
    assert "PREVIOUS ATTEMPT WAS REJECTED" in ref and "The window changed." in ref
    assert "Use a blue rug." in ref
    # feedback comes after the plan so it is read last
    assert ref.index("PREVIOUS ATTEMPT") > ref.index("STAGING PLAN")


def test_minimal_styling_wording_for_kitchen():
    analysis = room_analysis(room_type="kitchen", fixed=[])
    prompt = build_render_prompt(build_plan(analysis, "modern", "kitchen"), analysis)
    assert "MINIMAL" in prompt and "do not add furniture to the kitchen floor" in prompt


def test_declutter_prompt_removes_items_but_keeps_architecture():
    analysis = room_analysis()
    analysis["existing_items"] = ["old couch", "boxes"]
    prompt = build_declutter_prompt(analysis)
    assert "Remove all movable furniture" in prompt and "old couch, boxes" in prompt
    assert "KEEP IDENTICAL" in prompt and "Do not remove anything fixed" in prompt
