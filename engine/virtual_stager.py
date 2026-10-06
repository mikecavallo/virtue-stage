#!/usr/bin/env python3
"""
VirtueStage staging engine CLI.

Runs the staging pipeline (analyze -> plan -> render N candidates -> verify ->
select, see staging/pipeline.py) on one photo.

Backend contract (backend/server.js spawns this script):
- writes ``<stem>_staged_<style>_<provider><ext>`` next to the input image,
  at exactly the input's width and height;
- writes ``<stem>_staged_<style>_<provider>.json`` beside it with the analysis,
  plan, every candidate's scores and the selected candidate;
- exits 0 on success, 1 on bad input / missing provider, 2 if generation failed.

Providers: ``gemini`` (default), ``openai`` (gpt-image-1 render, Gemini vision if
a Gemini key is set) and ``fake`` (offline, deterministic; also selected by
``VIRTUESTAGE_PROVIDER=fake``) for tests and demos.
"""

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from staging.analysis import ROOM_TYPES  # noqa: E402
from staging.imaging import load_image, save_image  # noqa: E402
from staging.pipeline import MODES, StagingConfig, StagingError, StagingPipeline  # noqa: E402
from staging.providers import ProviderError, make_providers  # noqa: E402
from staging.styles import STYLE_KEYS  # noqa: E402


def env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def output_paths(image_path: str, style: str, provider: str, output: str = None):
    p = Path(image_path)
    out = Path(output) if output else p.parent / f"{p.stem}_staged_{style}_{provider}{p.suffix or '.jpg'}"
    return out, out.with_suffix(".json")


def build_parser():
    ap = argparse.ArgumentParser(description="VirtueStage virtual staging engine")
    ap.add_argument("image_path", help="room photo to stage")
    ap.add_argument("--style", choices=STYLE_KEYS, default="modern")
    ap.add_argument("--room-type", default="auto", choices=("auto",) + ROOM_TYPES,
                    help="room type; 'auto' uses the vision analysis")
    ap.add_argument("--mode", choices=MODES, default="stage",
                    help="stage (default), declutter (empty the room only), declutter_stage (empty, then stage)")
    ap.add_argument("--models", nargs="+", choices=["gemini", "openai", "fake"], default=None,
                    help="render provider (first one is used). Default: gemini, or $VIRTUESTAGE_PROVIDER")
    ap.add_argument("--gemini-model", default=os.getenv("GEMINI_IMAGE_MODEL", "gemini-flash"),
                    help="image model alias (gemini-flash, gemini-pro) or full id. Env: GEMINI_IMAGE_MODEL")
    ap.add_argument("--vision-model", default=os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash"),
                    help="model for room analysis and the quality judge. Env: GEMINI_VISION_MODEL")
    ap.add_argument("--candidates", type=int, default=env_int("STAGING_CANDIDATES", 2),
                    help="renders per round (default 2, env STAGING_CANDIDATES)")
    ap.add_argument("--max-retries", type=int, default=env_int("STAGING_MAX_RETRIES", 1),
                    help="extra rounds with judge feedback when no candidate passes (default 1)")
    ap.add_argument("--reference-image", help="staged image of the same room (multi-angle consistency)")
    ap.add_argument("--reference-plan", help="metadata JSON written for the reference image; reuses its furniture list")
    ap.add_argument("--prompt", help="extra instructions appended to the generated prompt")
    ap.add_argument("--watermark", action="store_true", help="burn a 'Virtually Staged' disclosure label into the output")
    ap.add_argument("--output", help="explicit output path (default: next to the input)")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not os.path.exists(args.image_path):
        print(f"Error: image '{args.image_path}' not found", file=sys.stderr)
        return 1
    provider_name = (args.models or [os.getenv("VIRTUESTAGE_PROVIDER", "gemini")])[0]
    try:
        vision, renderer = make_providers(provider_name, args.gemini_model, args.vision_model)
    except ProviderError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    reference_image = load_image(args.reference_image) if args.reference_image and os.path.exists(args.reference_image) else None
    reference_plan = None
    if args.reference_plan and os.path.exists(args.reference_plan):
        with open(args.reference_plan, encoding="utf-8") as f:
            reference_plan = json.load(f).get("plan")

    cfg = StagingConfig(style=args.style, room_type=args.room_type, mode=args.mode,
                        candidates=max(1, args.candidates), max_retries=max(0, args.max_retries),
                        reference_image=reference_image, reference_plan=reference_plan,
                        custom_instructions=args.prompt, watermark=args.watermark)
    pipeline = StagingPipeline(renderer=renderer, vision=vision, log=lambda m: print(m, flush=True))
    print(f"Staging {args.image_path}: style={args.style} mode={args.mode} provider={provider_name} "
          f"candidates={cfg.candidates}", flush=True)
    try:
        result = pipeline.run(load_image(args.image_path), cfg)
    except (StagingError, ProviderError) as e:
        print(f"Error: staging failed: {e}", file=sys.stderr)
        return 2

    out_path, meta_path = output_paths(args.image_path, args.style, provider_name, args.output)
    save_image(result.image, out_path)
    result.metadata["output_path"] = str(out_path)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(result.metadata, f, indent=2, default=str)
    q = result.metadata["quality"]
    print(f"Saved {out_path} ({result.image.width}x{result.image.height}); quality passed={q['passed']} "
          f"fidelity={q['fidelity']} judge={q['judge_overall']}")
    print(f"Metadata: {meta_path}")
    for w in result.metadata["warnings"]:
        print(f"Warning: {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
