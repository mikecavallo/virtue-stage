"""The staging pipeline: analyze -> (declutter) -> plan -> render N candidates -> verify -> select (-> retry).

    original photo
         |
     [analyze]  vision model -> room type, camera, light, fixed elements, size class, occupancy
         |
    [declutter] optional: remove existing furniture first (mode declutter / declutter_stage)
         |
       [plan]   deterministic rules + style preset -> furniture list, sizes, wall placement, rug
         |
      [render]  constrained edit prompt, N candidates, aspect ratio requested + restored to input size
         |
      [verify]  structural fidelity (numpy) + vision judge rubric (JSON) -> combined score
         |
      [select]  best passing candidate; if none passes, one retry round with the feedback appended
         |
    output image (+ metadata JSON with analysis, plan, scores)
"""

import time
from dataclasses import dataclass, field
from typing import Callable, List, Optional

from PIL import Image

from . import __version__
from .analysis import analyze_room, apply_room_type_override
from .fidelity import structural_fidelity
from .imaging import aspect_mismatch, plan_canvas, prepare_model_input, restore_to_input
from .judge import judge_candidate
from .planner import build_plan, validate_plan
from .prompts import build_declutter_prompt, build_render_prompt
from .providers import Provider
from .selection import candidate_passed, combined_score, retry_feedback, select_best
from .watermark import add_disclosure

MODES = ("stage", "declutter", "declutter_stage")


@dataclass
class StagingConfig:
    style: str = "modern"
    room_type: Optional[str] = None  # None/"auto" = use the analysis
    mode: str = "stage"
    candidates: int = 2
    max_retries: int = 1
    reference_image: Optional[Image.Image] = None
    reference_plan: Optional[dict] = None
    custom_instructions: Optional[str] = None
    watermark: bool = False
    fidelity_thresholds: dict = field(default_factory=dict)
    judge_thresholds: dict = field(default_factory=dict)
    max_model_side: int = 1536


@dataclass
class StagingResult:
    image: Image.Image
    metadata: dict
    candidates: List[dict] = field(default_factory=list)


class StagingError(RuntimeError):
    pass


class StagingPipeline:
    def __init__(self, renderer: Provider, vision: Optional[Provider] = None,
                 log: Optional[Callable[[str], None]] = None):
        self.renderer = renderer
        self.vision = vision
        self.log = log or (lambda msg: None)

    # ── one render round ───────────────────────────────────────────────
    def _render_round(self, base: Image.Image, original: Image.Image, prompt: str, n: int, attempt: int,
                      analysis: dict, plan: dict, cfg: StagingConfig, mode: str) -> List[dict]:
        canvas = plan_canvas(*base.size)
        model_input = prepare_model_input(base, canvas, cfg.max_model_side)
        images = [model_input]
        if cfg.reference_image is not None and mode == "stage":
            ref = cfg.reference_image.copy()
            ref.thumbnail((cfg.max_model_side, cfg.max_model_side), Image.LANCZOS)
            images.append(ref)
        out = []
        for i in range(n):
            entry = {"attempt": attempt, "index": i, "mode": mode, "image": None}
            t0 = time.time()
            try:
                raw = self.renderer.edit_image(prompt, images, aspect_ratio=canvas.aspect_ratio)
            except Exception as e:
                entry.update(error=str(e)[:300], passed=False, combined=-1.0)
                self.log(f"[{mode} {attempt}.{i}] render failed: {e}")
                out.append(entry)
                continue
            entry["render_seconds"] = round(time.time() - t0, 2)
            entry["native_size"] = list(raw.size)
            entry["native_aspect_mismatch"] = round(aspect_mismatch(raw.size, base.size), 4)
            img = restore_to_input(raw, canvas)
            fid = structural_fidelity(original, img, analysis, cfg.fidelity_thresholds)
            judge = judge_candidate(self.vision, base, img, plan, mode="declutter" if mode == "declutter" else "stage",
                                    reference=cfg.reference_image if mode == "stage" else None,
                                    thresholds=cfg.judge_thresholds)
            entry.update(image=img, fidelity=fid, judge=judge, combined=combined_score(fid, judge),
                         passed=candidate_passed(fid, judge))
            self.log(f"[{mode} {attempt}.{i}] fidelity={fid['score']:.3f} judge="
                     f"{judge.get('overall') if judge.get('available') else 'n/a'} combined={entry['combined']:.2f} "
                     f"passed={entry['passed']}")
            out.append(entry)
        return out

    def _generate(self, base, original, analysis, plan, cfg, mode, prompt_fn):
        all_candidates: List[dict] = []
        prompt = prompt_fn(None)
        prompts = [prompt]
        for attempt in range(cfg.max_retries + 1):
            round_ = self._render_round(base, original, prompt, cfg.candidates, attempt, analysis, plan, cfg, mode)
            all_candidates += round_
            if any(c.get("passed") for c in round_):
                break
            if attempt < cfg.max_retries:
                feedback = retry_feedback(round_)
                self.log(f"[{mode}] no candidate passed; retrying with feedback")
                prompt = prompt_fn(feedback)
                prompts.append(prompt)
        best = select_best(all_candidates)
        if best is None:
            errors = "; ".join(c.get("error", "") for c in all_candidates)
            raise StagingError(f"{mode}: every render failed ({errors})")
        return all_candidates, best, prompts

    # ── public entry point ─────────────────────────────────────────────
    def run(self, original: Image.Image, cfg: StagingConfig) -> StagingResult:
        if cfg.mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        t_start = time.time()
        original = original.convert("RGB")
        meta = {
            "engine_version": __version__,
            "mode": cfg.mode,
            "style": cfg.style,
            "input_size": list(original.size),
            "renderer": {"provider": self.renderer.name, "model": self.renderer.image_model},
            "vision": ({"provider": self.vision.name, "model": self.vision.vision_model}
                       if self.vision is not None and getattr(self.vision, "supports_vision", True) else None),
            "settings": {"candidates": cfg.candidates, "max_retries": cfg.max_retries,
                         "reference_image": cfg.reference_image is not None,
                         "reference_plan": cfg.reference_plan is not None},
            "warnings": [],
        }

        analysis = analyze_room(self.vision, original, cfg.room_type if cfg.room_type != "auto" else None, self.log)
        analysis = apply_room_type_override(analysis, cfg.room_type)
        meta["analysis"] = analysis
        if analysis.get("source", "").startswith("default"):
            meta["warnings"].append(f"room analysis unavailable: {analysis['source']}")
        meta["canvas"] = plan_canvas(*original.size).to_dict()

        candidates_meta = []
        base = original
        all_candidates: List[dict] = []

        if cfg.mode in ("declutter", "declutter_stage"):
            dec_cands, best, prompts = self._generate(
                original, original, analysis, {}, cfg, "declutter",
                lambda fb: build_declutter_prompt(analysis, fb))
            base = dec_cands[best]["image"]
            meta["declutter"] = {"selected": best, "passed": dec_cands[best]["passed"], "prompts": prompts}
            all_candidates += dec_cands
            if not dec_cands[best]["passed"]:
                meta["warnings"].append("no declutter candidate passed quality thresholds; using the best one")
            if cfg.mode == "declutter":
                return self._finish(base, meta, all_candidates, dec_cands[best], cfg, t_start)
            analysis = dict(analysis, occupancy="empty", existing_items=[])

        plan = build_plan(analysis, cfg.style, analysis["room_type"], cfg.reference_plan)
        meta["plan"] = plan
        violations = validate_plan(plan, analysis)
        if violations:
            meta["warnings"].append(f"plan rule violations: {violations}")
        has_ref = cfg.reference_image is not None
        stage_cands, best, prompts = self._generate(
            base, original, analysis, plan, cfg, "stage",
            lambda fb: build_render_prompt(plan, analysis, has_reference=has_ref, feedback=fb,
                                           custom_instructions=cfg.custom_instructions))
        meta["prompts"] = prompts
        all_candidates += stage_cands
        if not stage_cands[best]["passed"]:
            meta["warnings"].append("no candidate passed quality thresholds after retry; returning the best-scoring one")
        return self._finish(stage_cands[best]["image"], meta, all_candidates, stage_cands[best], cfg, t_start)

    def _finish(self, image, meta, all_candidates, chosen, cfg, t_start) -> StagingResult:
        meta["candidates"] = [{k: v for k, v in c.items() if k != "image"} for c in all_candidates]
        meta["selected"] = {"mode": chosen["mode"], "attempt": chosen["attempt"], "index": chosen["index"]}
        meta["passed"] = bool(chosen["passed"])
        meta["quality"] = {
            "passed": bool(chosen["passed"]),
            "fidelity": chosen["fidelity"]["score"],
            "judge_overall": chosen["judge"].get("overall") if chosen["judge"].get("available") else None,
            "combined": chosen["combined"],
            "renders": len(all_candidates),
        }
        if cfg.watermark:
            image = add_disclosure(image)
            meta["disclosure_watermark"] = True
        meta["output_size"] = list(image.size)
        meta["total_seconds"] = round(time.time() - t_start, 2)
        return StagingResult(image=image, metadata=meta, candidates=all_candidates)
