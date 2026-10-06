from staging.judge import judge_candidate, judge_prompt, normalize_judgement
from staging.providers import DEFAULT_FAKE_JUDGE, FakeProvider
from staging.selection import candidate_passed, combined_score, retry_feedback, select_best
from synthetic import draw_room

GOOD = dict(DEFAULT_FAKE_JUDGE)


def fid(score, passed=True, failed=()):
    return {"score": score, "passed": passed, "failed_regions": list(failed), "shift_frac": [0, 0]}


def test_normalize_clamps_and_computes_pass():
    j = normalize_judgement(dict(GOOD, photorealism=14, scale="7"))
    assert j["scores"]["photorealism"] == 10 and j["scores"]["scale"] == 7
    assert j["passed"] and 7 < j["overall"] <= 10


def test_architecture_and_mls_have_stricter_thresholds():
    j = normalize_judgement(dict(GOOD, architecture_preserved=6.5))
    assert not j["passed"] and "architecture_preserved" in j["fail_reasons"][0]
    j = normalize_judgement(dict(GOOD, mls_appropriate=7))
    assert not j["passed"]
    j = normalize_judgement(dict(GOOD, perspective=4))
    assert not j["passed"] and "perspective 4 < 6" in j["fail_reasons"]


def test_missing_scores_fail_and_empty_is_unavailable():
    j = normalize_judgement({"photorealism": 9})
    assert not j["passed"] and any("missing" in r for r in j["fail_reasons"])
    assert normalize_judgement({})["available"] is False


def test_judge_prompt_mentions_reference_only_when_given():
    plan = {"style_label": "Coastal", "style_summary": "airy", "pieces": [{"description": "white sofa"}]}
    assert "consistency_with_reference" not in judge_prompt(plan)
    assert "consistency_with_reference" in judge_prompt(plan, has_reference=True)
    assert "white sofa" in judge_prompt(plan)


def test_judge_candidate_handles_provider_failure():
    img = draw_room((200, 120))
    res = judge_candidate(FakeProvider(fail_vision=True), img, img, {})
    assert res["available"] is False
    assert judge_candidate(None, img, img, {})["available"] is False


def test_combined_score_and_pass_logic():
    judge = normalize_judgement(GOOD)
    assert combined_score(fid(0.9), judge) == round(0.4 * 9 + 0.6 * judge["overall"], 3)
    assert combined_score(fid(0.9), {"available": False}) == 9.0
    assert candidate_passed(fid(0.9), judge)
    assert not candidate_passed(fid(0.9, passed=False), judge)
    assert candidate_passed(fid(0.9), {"available": False})


def test_select_best_prefers_passing_over_higher_score():
    cands = [
        {"image": object(), "passed": False, "combined": 9.5},
        {"image": object(), "passed": True, "combined": 7.0},
        {"image": None, "passed": False, "combined": -1, "error": "boom"},
    ]
    assert select_best(cands) == 1
    cands[1]["passed"] = False
    assert select_best(cands) == 0
    assert select_best([{"image": None, "passed": False, "combined": -1}]) is None


def test_retry_feedback_names_failed_regions_and_judge_issues():
    judge = normalize_judgement(dict(GOOD, scale=4, issues=["sofa is too small for the wall"],
                                     feedback="make the sofa 84 in wide"))
    cands = [{"image": object(), "passed": False, "combined": 5.0,
              "fidelity": fid(0.5, passed=False, failed=["window: back window"]), "judge": judge}]
    fb = retry_feedback(cands)
    assert "window: back window changed" in fb
    assert "scale 4 < 6" in fb and "sofa is too small" in fb and "84 in wide" in fb
