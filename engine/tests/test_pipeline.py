import json

import pytest
from PIL import Image

from staging.pipeline import StagingConfig, StagingError, StagingPipeline
from staging.planner import build_plan
from staging.providers import DEFAULT_FAKE_JUDGE, FakeProvider
from synthetic import draw_room, room_analysis


def fake(**kw):
    kw.setdefault("responses", {"analysis": room_analysis()})
    return FakeProvider(**kw)


def run(provider, size=(960, 640), **cfg):
    pipe = StagingPipeline(renderer=provider, vision=provider)
    return pipe.run(draw_room(size), StagingConfig(**cfg))


def edits(p):
    return [c for c in p.calls if c["kind"] == "edit"]


def test_output_matches_input_size_and_requests_matching_aspect_ratio():
    p = fake()
    res = run(p, size=(1500, 1000), style="coastal")
    assert res.image.size == (1500, 1000)
    assert {c["aspect_ratio"] for c in edits(p)} == {"3:2"}
    assert len(edits(p)) == 2  # default N=2 candidates, both passed, no retry


def test_square_output_from_model_is_restored_to_input_size():
    res = run(fake(output_size=(1024, 1024)), size=(1200, 800))
    assert res.image.size == (1200, 800)
    assert res.metadata["candidates"][0]["native_size"] == [1024, 1024]


def test_metadata_records_analysis_plan_scores_and_selection():
    res = run(fake(), style="farmhouse", room_type="bedroom")
    m = res.metadata
    assert m["analysis"]["room_type"] == "bedroom" and m["analysis"]["detected_room_type"] == "living-room"
    assert m["plan"]["style"] == "farmhouse" and m["plan"]["pieces"]
    assert len(m["candidates"]) == 2 and all("fidelity" in c and "judge" in c for c in m["candidates"])
    assert m["selected"]["mode"] == "stage" and m["passed"] is True
    assert m["quality"]["fidelity"] > 0.9 and m["quality"]["judge_overall"] > 7
    json.dumps(m)  # serializable (no PIL images)


def test_retry_with_feedback_when_first_round_alters_architecture():
    p = fake(alter_architecture=lambda idx: idx < 2)
    res = run(p, candidates=2, max_retries=1)
    prompts = [c["prompt"] for c in edits(p)]
    assert len(prompts) == 4
    assert "PREVIOUS ATTEMPT" not in prompts[0]
    assert "PREVIOUS ATTEMPT WAS REJECTED" in prompts[2] and "top band" in prompts[2]
    assert res.metadata["selected"]["attempt"] == 1 and res.metadata["passed"]


def test_judge_rejection_also_triggers_retry():
    judge_calls = {"n": 0}

    def judge(prompt, images, n):
        bad = dict(DEFAULT_FAKE_JUDGE, scale=3, issues=["bed is toy-sized"], feedback="make the bed queen size")
        return bad if n <= 2 else DEFAULT_FAKE_JUDGE

    p = fake(responses={"analysis": room_analysis(), "judge": judge})
    res = run(p)
    assert "bed is toy-sized" in edits(p)[2]["prompt"]
    assert res.metadata["passed"]


def test_all_candidates_failing_returns_best_with_warning():
    res = run(fake(alter_architecture=True), candidates=2, max_retries=1)
    assert res.metadata["passed"] is False
    assert len(res.metadata["candidates"]) == 4
    assert any("no candidate passed" in w for w in res.metadata["warnings"])


def test_render_errors_are_recorded_and_all_errors_raise():
    def flaky(src, prompt, idx):
        if idx == 0:
            raise RuntimeError("quota")
        return src.copy()

    res = run(fake(edit_fn=flaky))
    assert "quota" in res.metadata["candidates"][0]["error"]

    def broken(src, prompt, idx):
        raise RuntimeError("down")

    with pytest.raises(StagingError):
        run(fake(edit_fn=broken))


def test_without_vision_uses_default_analysis_and_fidelity_only():
    p = fake()
    pipe = StagingPipeline(renderer=p, vision=None)
    res = pipe.run(draw_room(), StagingConfig(style="modern", room_type="living-room"))
    assert res.metadata["analysis"]["source"].startswith("default")
    assert res.metadata["candidates"][0]["judge"]["available"] is False
    assert any("analysis unavailable" in w for w in res.metadata["warnings"])


def test_vision_failure_falls_back_gracefully():
    p = fake(fail_vision=True)
    res = run(p)
    assert res.metadata["analysis"]["source"].startswith("default (analysis failed")
    assert res.image is not None


def test_multi_angle_passes_reference_image_and_reuses_plan():
    hero_plan = build_plan(room_analysis(size_class="large"), "luxury")
    p = fake()
    ref = draw_room((640, 480), seed=5)
    res = run(p, style="luxury", reference_image=ref, reference_plan=hero_plan)
    assert all(c["n_images"] == 2 for c in edits(p))
    assert "IMAGE 2 shows the SAME room" in edits(p)[0]["prompt"]
    assert [x["description"] for x in res.metadata["plan"]["pieces"]] == [x["description"] for x in hero_plan["pieces"]]
    judge_calls = [c for c in p.calls if c.get("task") == "judge"]
    assert judge_calls and all(c["n_images"] == 3 for c in judge_calls)


def test_declutter_modes():
    p = fake()
    res = run(p, mode="declutter")
    assert all("Remove all movable furniture" in c["prompt"] for c in edits(p))
    assert "plan" not in res.metadata and res.metadata["selected"]["mode"] == "declutter"

    p = fake()
    res = run(p, mode="declutter_stage")
    prompts = [c["prompt"] for c in edits(p)]
    assert "Remove all movable furniture" in prompts[0] and "STAGING PLAN" in prompts[-1]
    assert res.metadata["declutter"]["passed"] and res.metadata["selected"]["mode"] == "stage"


def test_watermark_option():
    res = run(fake(), watermark=True)
    assert res.metadata["disclosure_watermark"] is True
    assert res.image.size == (960, 640)


def test_invalid_mode_rejected():
    with pytest.raises(ValueError):
        run(fake(), mode="paint")
