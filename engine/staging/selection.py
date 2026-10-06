"""Step 5c: combine fidelity + judge scores, pick the best candidate, build retry feedback."""

from typing import List, Optional

FIDELITY_WEIGHT = 0.4
JUDGE_WEIGHT = 0.6


def combined_score(fidelity: dict, judge: Optional[dict]) -> float:
    """0-10 scale. Without a judge, fidelity alone decides."""
    fid = fidelity["score"] * 10
    if judge and judge.get("available"):
        return round(FIDELITY_WEIGHT * fid + JUDGE_WEIGHT * judge["overall"], 3)
    return round(fid, 3)


def candidate_passed(fidelity: dict, judge: Optional[dict]) -> bool:
    if not fidelity["passed"]:
        return False
    if judge and judge.get("available"):
        return bool(judge["passed"])
    return True


def select_best(candidates: List[dict]) -> Optional[int]:
    """Index of the best usable candidate: passing ones first, then by combined score."""
    usable = [i for i, c in enumerate(candidates) if c.get("image") is not None]
    if not usable:
        return None
    return max(usable, key=lambda i: (candidates[i]["passed"], candidates[i]["combined"]))


def retry_feedback(candidates: List[dict]) -> str:
    """Turn the best failed candidate's problems into instructions for the retry prompt."""
    best_idx = select_best(candidates)
    if best_idx is None:
        return "The previous attempts produced no image. Return one edited photo."
    c = candidates[best_idx]
    lines = []
    fid = c["fidelity"]
    for name in fid.get("failed_regions", []):
        lines.append(f"- The {name} changed. It must stay pixel-identical to the original photo.")
    if not fid["passed"] and not fid.get("failed_regions"):
        lines.append("- The room's architecture or framing drifted from the original. Keep walls, windows, ceiling "
                     "and camera framing identical; only add furniture.")
    if abs(fid["shift_frac"][0]) > 0.01 or abs(fid["shift_frac"][1]) > 0.01:
        lines.append("- The image was shifted or re-framed. Keep the exact original framing.")
    judge = c.get("judge") or {}
    if judge.get("available"):
        for reason in judge.get("fail_reasons", []):
            lines.append(f"- Score too low: {reason}.")
        for issue in judge.get("issues", [])[:6]:
            lines.append(f"- {issue}")
        if judge.get("feedback"):
            lines.append(f"- Reviewer: {judge['feedback']}")
    return "\n".join(lines) or "- Improve realism and keep the room's architecture identical."
