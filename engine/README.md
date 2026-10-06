# VirtueStage engine

Python staging pipeline the backend runs as a subprocess. Overview and diagram: see
"How staging works" in the top-level README.

| Path | Purpose |
|---|---|
| `virtual_stager.py` | CLI and backend contract. Writes `<stem>_staged_<style>_<provider><ext>` (same size as the input) and a `.json` metadata file next to the input. Exit 0 ok, 1 bad input/no provider, 2 generation failed. |
| `staging/analysis.py` | Vision pass: structured JSON room analysis, normalized and validated. |
| `staging/planner.py` | Deterministic staging plan: room-type rules, size scaling, wall placement, rugs, keep-clear list. |
| `staging/prompts.py` | Edit prompts for staging and decluttering (preserve list, camera, lighting, plan, MLS rules). |
| `staging/imaging.py` | Aspect-ratio choice, padding, restoring output to the exact input size. |
| `staging/fidelity.py` | Structural fidelity: SSIM + edge F1 + color shift in regions that must not change. |
| `staging/judge.py` | Vision-model rubric judge (JSON scores 0-10). |
| `staging/selection.py` | Combined score, best-candidate selection, retry feedback. |
| `staging/watermark.py` | "Virtually Staged" disclosure label. |
| `staging/providers.py` | `GeminiProvider` (vision + image), `OpenAIImageProvider` (image only), `FakeProvider` (offline). |
| `staging/styles.json` | Eight style presets, shared with the backend. |
| `eval/run.py` | Batch run over a folder with an HTML report. |
| `detect_room.py` | Quick room-type classification used by the backend for "auto". |

## Usage

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=...
python3 virtual_stager.py path/to/room.jpg --style coastal --room-type living-room
python3 virtual_stager.py path/to/furnished.jpg --style farmhouse --mode declutter_stage
python3 virtual_stager.py angle2.jpg --style coastal \
  --reference-image room_staged_coastal_gemini.jpg --reference-plan room_staged_coastal_gemini.json
```

Options: `--candidates N` (default 2, env `STAGING_CANDIDATES`), `--max-retries` (default 1),
`--gemini-model` (`gemini-flash` = `gemini-2.5-flash-image`, `gemini-pro` =
`gemini-3-pro-image-preview`, or a full id; env `GEMINI_IMAGE_MODEL`), `--vision-model`
(default `gemini-2.5-flash`, env `GEMINI_VISION_MODEL`), `--watermark`, `--prompt` (extra
instructions appended to the generated prompt), `--models openai` (gpt-image-1 renders; analysis
and judge still use Gemini when a Gemini key is set, otherwise fidelity scoring only).

Each render round costs `N` image calls plus `N` judge calls; analysis is one more call. With the
defaults a job makes 5 model calls, or 9 if the retry round runs.

## Tests and evaluation

```bash
pip install -r requirements-dev.txt
python -m pytest                                   # offline, fake provider
python -m eval.run --images eval/samples --styles modern,coastal               # needs GEMINI_API_KEY
python -m eval.run --images eval/samples --styles modern --provider fake       # harness check, no key
```

`VIRTUESTAGE_PROVIDER=fake` makes the CLI use the fake provider (the backend contract test uses
this). The fake draws placeholder boxes; its output says nothing about real staging quality.

The fidelity and judge thresholds (`fidelity.DEFAULT_THRESHOLDS`, `judge.DEFAULT_THRESHOLDS`) are
starting values that have not been calibrated against real Gemini output yet. Run the eval
harness on real photos and adjust them from the report.
