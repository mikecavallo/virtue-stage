"""Step 5b: vision-LLM judge. Scores a candidate against a fixed rubric (JSON)."""

from typing import Optional

from PIL import Image

from .providers import Provider

CRITERIA = {
    "photorealism": "Looks like a real photograph: believable materials, textures, no CGI/plastic look, no warped objects or melted edges.",
    "scale": "Furniture is correctly sized for the room (compare to doors ~80 in, windows, outlets); nothing toy-sized or oversized.",
    "perspective": "Every piece follows the room's perspective and vanishing lines and sits on the floor plane (no floating, tilting or sinking).",
    "lighting_match": "Light direction, color temperature, shadows and contact shadows on the new items match the original photo.",
    "architecture_preserved": "Walls, wall color, windows, doors, floor, ceiling, fixtures, camera angle and framing are unchanged from the original.",
    "mls_appropriate": "No people, pets, text, logos, screens with content, clutter; doorways, windows and walkways are not blocked.",
    "style_match": "Furniture and decor match the requested style and palette and follow the plan.",
}
WEIGHTS = {"photorealism": 1.5, "scale": 1.2, "perspective": 1.2, "lighting_match": 1.0,
           "architecture_preserved": 1.5, "mls_appropriate": 1.0, "style_match": 0.8}
DEFAULT_THRESHOLDS = {"min_any": 6, "architecture_preserved": 7, "mls_appropriate": 8}

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {**{k: {"type": "number"} for k in CRITERIA},
                   "consistency_with_reference": {"type": "number"},
                   "issues": {"type": "array", "items": {"type": "string"}},
                   "feedback": {"type": "string"}},
    "required": list(CRITERIA) + ["issues", "feedback"],
}


def judge_prompt(plan: dict, mode: str = "stage", has_reference: bool = False) -> str:
    if mode == "declutter":
        task = ("IMAGE 2 should be IMAGE 1 with all movable furniture and clutter removed and nothing else changed. "
                "For style_match, score how completely and cleanly the room was emptied.")
    else:
        pieces = "; ".join(p["description"] for p in plan.get("pieces", [])) if plan else ""
        task = (f"IMAGE 2 should be IMAGE 1 virtually staged in {plan.get('style_label', '')} style "
                f"({plan.get('style_summary', '')}). Planned items: {pieces}.")
    rubric = "\n".join(f"- {k} (0-10): {v}" for k, v in CRITERIA.items())
    ref = ("\nIMAGE 3 is the reference staging of the same room from another angle. Also score "
           "consistency_with_reference (0-10): same furniture pieces, colors and materials.") if has_reference else ""
    return f"""You are a strict quality reviewer for virtual staging in real estate listings (MLS).
IMAGE 1 is the original photo. {task}{ref}
Score IMAGE 2 on each criterion from 0 (unusable) to 10 (indistinguishable from a professional photo of a staged home):
{rubric}
Be harsh: any changed window, wall color, floor or camera framing caps architecture_preserved at 4. Any floating, mis-scaled or warped furniture caps scale/perspective at 5.
Return ONLY JSON: {{"photorealism": n, "scale": n, "perspective": n, "lighting_match": n, "architecture_preserved": n, "mls_appropriate": n, "style_match": n,{' "consistency_with_reference": n,' if has_reference else ''} "issues": ["specific problem with location", ...], "feedback": "concrete instructions to fix the issues in a retry"}}"""


def _num(v) -> Optional[float]:
    try:
        return max(0.0, min(10.0, float(v)))
    except (TypeError, ValueError):
        return None


def normalize_judgement(raw: dict, thresholds: Optional[dict] = None) -> dict:
    th = dict(DEFAULT_THRESHOLDS, **(thresholds or {}))
    scores = {k: _num(raw.get(k)) for k in CRITERIA}
    if raw.get("consistency_with_reference") is not None:
        scores["consistency_with_reference"] = _num(raw.get("consistency_with_reference"))
    present = {k: v for k, v in scores.items() if v is not None}
    if not present:
        return {"available": False, "error": "judge returned no scores", "raw": raw}
    weights = {k: WEIGHTS.get(k, 1.0) for k in present}
    overall = sum(present[k] * weights[k] for k in present) / sum(weights.values())
    reasons = [f"{k} {v:g} < {th['min_any']}" for k, v in present.items() if v < th["min_any"]]
    for key in ("architecture_preserved", "mls_appropriate"):
        if key in present and present[key] < th[key] and present[key] >= th["min_any"]:
            reasons.append(f"{key} {present[key]:g} < {th[key]}")
    missing = [k for k in CRITERIA if scores[k] is None]
    if missing:
        reasons.append(f"missing scores: {', '.join(missing)}")
    return {
        "available": True,
        "scores": scores,
        "overall": round(overall, 2),
        "passed": not reasons,
        "fail_reasons": reasons,
        "issues": [str(i) for i in raw.get("issues") or []][:10],
        "feedback": str(raw.get("feedback") or "")[:1000],
        "thresholds": th,
    }


def judge_candidate(provider: Optional[Provider], original: Image.Image, candidate: Image.Image, plan: dict,
                    mode: str = "stage", reference: Optional[Image.Image] = None,
                    thresholds: Optional[dict] = None, max_side: int = 1024) -> dict:
    if provider is None or not getattr(provider, "supports_vision", True):
        return {"available": False, "error": "no vision provider"}
    imgs = [original, candidate] + ([reference] if reference is not None else [])
    small = []
    for im in imgs:
        im = im.copy()
        im.thumbnail((max_side, max_side), Image.LANCZOS)
        small.append(im)
    try:
        raw = provider.generate_json(judge_prompt(plan, mode, reference is not None), small, task="judge",
                                     schema=JUDGE_SCHEMA)
    except Exception as e:
        return {"available": False, "error": f"judge call failed: {str(e)[:200]}"}
    return normalize_judgement(raw, thresholds)
