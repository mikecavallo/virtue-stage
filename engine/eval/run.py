"""Run the full staging pipeline over a folder of photos and write a side-by-side HTML report.

    cd engine
    export GEMINI_API_KEY=...
    python -m eval.run --images eval/samples --styles modern,coastal

Writes ``eval/out/<timestamp>/report.html`` with before/after pairs, every
candidate, the structural-fidelity regions, the judge rubric scores and the
plan, so thresholds and prompts can be tuned on real output. ``--provider fake``
runs offline (useful to check the harness itself; the images are not real staging).
"""

import argparse
import html
import json
import sys
import time
import traceback
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))

from staging.imaging import load_image, save_image, thumbnail  # noqa: E402
from staging.pipeline import MODES, StagingConfig, StagingPipeline  # noqa: E402
from staging.providers import make_providers  # noqa: E402
from staging.styles import STYLE_KEYS  # noqa: E402

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
REPORT_MAX_SIDE = 1400


def find_images(folder: Path, limit=None):
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    return files[:limit] if limit else files


def esc(v) -> str:
    return html.escape(str(v))


def fmt(v, nd=2):
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return esc(v)


def run_eval(images, styles, out_dir: Path, provider="gemini", room_type="auto", mode="stage",
             candidates=2, max_retries=1, image_model="gemini-flash", vision_model="gemini-2.5-flash", log=print):
    vision, renderer = make_providers(provider, image_model, vision_model)
    pipeline = StagingPipeline(renderer=renderer, vision=vision, log=lambda m: log(f"    {m}"))
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for img_path in images:
        original = load_image(img_path)
        before_name = f"{img_path.stem}__before.jpg"
        save_image(thumbnail(original, REPORT_MAX_SIDE), out_dir / before_name)
        for style in styles:
            tag = f"{img_path.stem}__{style}"
            log(f"[{tag}]")
            row = {"image": img_path.name, "style": style, "before": before_name}
            t0 = time.time()
            try:
                res = pipeline.run(original, StagingConfig(style=style, room_type=room_type, mode=mode,
                                                           candidates=candidates, max_retries=max_retries))
            except Exception as e:  # keep going; record the failure in the report
                row.update(error=f"{type(e).__name__}: {e}", trace=traceback.format_exc(limit=3))
                rows.append(row)
                continue
            after_name = f"{tag}__after.jpg"
            save_image(thumbnail(res.image, REPORT_MAX_SIDE), out_dir / after_name)
            cand_files = []
            for c in res.candidates:
                if c.get("image") is None:
                    cand_files.append(None)
                    continue
                name = f"{tag}__{c['mode']}_a{c['attempt']}_c{c['index']}.jpg"
                save_image(thumbnail(c["image"], 600), out_dir / name)
                cand_files.append(name)
            with open(out_dir / f"{tag}.json", "w", encoding="utf-8") as f:
                json.dump(res.metadata, f, indent=2, default=str)
            row.update(after=after_name, metadata=res.metadata, candidate_files=cand_files,
                       seconds=round(time.time() - t0, 1), size_ok=res.image.size == original.size)
            rows.append(row)
    summary = {"provider": provider, "renderer_model": getattr(renderer, "image_model", None),
               "vision_model": getattr(vision, "vision_model", None) if vision else None,
               "styles": styles, "mode": mode, "candidates": candidates, "max_retries": max_retries,
               "created": time.strftime("%Y-%m-%d %H:%M:%S")}
    (out_dir / "results.json").write_text(json.dumps(
        {"summary": summary, "rows": [{k: v for k, v in r.items() if k != "trace"} for r in rows]},
        indent=2, default=str))
    (out_dir / "report.html").write_text(render_report(rows, summary), encoding="utf-8")
    return rows, out_dir / "report.html"


def _judge_table(judge):
    if not judge or not judge.get("available"):
        return f"<p class='muted'>Judge unavailable: {esc((judge or {}).get('error', ''))}</p>"
    cells = "".join(f"<tr><td>{esc(k)}</td><td>{fmt(v, 1)}</td></tr>" for k, v in judge["scores"].items())
    issues = "".join(f"<li>{esc(i)}</li>" for i in judge.get("issues", []))
    return (f"<table>{cells}<tr><th>overall</th><th>{fmt(judge['overall'])}</th></tr></table>"
            + (f"<ul>{issues}</ul>" if issues else "")
            + (f"<p class='muted'>{esc(judge['feedback'])}</p>" if judge.get("feedback") else ""))


def _fidelity_table(fid):
    rows = "".join(f"<tr><td>{esc(r['name'])}</td><td>{fmt(r['ssim'])}</td><td>{fmt(r['edge_f1'])}</td>"
                   f"<td>{fmt(r['color_delta'], 3)}</td><td class='{'bad' if r['name'] in fid['failed_regions'] else ''}'>"
                   f"{fmt(r['score'])}</td></tr>" for r in fid["regions"])
    return (f"<table><tr><th>region</th><th>SSIM</th><th>edge F1</th><th>color Δ</th><th>score</th></tr>{rows}"
            f"<tr><th colspan=4>overall (shift {esc(fid['shift_px'])} px)</th><th>{fmt(fid['score'])}</th></tr></table>")


def render_report(rows, summary) -> str:
    ok = [r for r in rows if "metadata" in r]
    passed = sum(1 for r in ok if r["metadata"]["passed"])
    by_style = {}
    for r in ok:
        s = by_style.setdefault(r["style"], {"n": 0, "pass": 0, "fid": [], "judge": []})
        q = r["metadata"]["quality"]
        s["n"] += 1
        s["pass"] += int(q["passed"])
        s["fid"].append(q["fidelity"])
        if q["judge_overall"] is not None:
            s["judge"].append(q["judge_overall"])

    def mean(xs):
        return sum(xs) / len(xs) if xs else None

    style_rows = "".join(
        f"<tr><td>{esc(k)}</td><td>{v['pass']}/{v['n']}</td><td>{fmt(mean(v['fid']), 3)}</td><td>{fmt(mean(v['judge']))}</td></tr>"
        for k, v in by_style.items())
    fake_note = ("<p class='warn'>Provider is <b>fake</b>: these outputs are synthetic placeholders that check the harness, "
                 "not real staging results.</p>" if summary["provider"] == "fake" else "")
    cards = []
    for r in rows:
        title = f"{esc(r['image'])} · {esc(r['style'])}"
        if "error" in r:
            cards.append(f"<section class='card'><h2>{title}</h2><p class='bad'>Failed: {esc(r['error'])}</p>"
                         f"<pre>{esc(r.get('trace', ''))}</pre></section>")
            continue
        m = r["metadata"]
        q = m["quality"]
        sel = m["selected"]
        chosen = next(c for c in m["candidates"] if c["mode"] == sel["mode"] and c["attempt"] == sel["attempt"]
                      and c["index"] == sel["index"])
        a = m["analysis"]
        plan = m.get("plan") or {}
        pieces = "".join(f"<li><b>{esc(p['id'])}</b>: {esc(p['description'])} "
                         f"<span class='muted'>[{esc(p.get('size', ''))}] {esc(p['placement'])}</span></li>"
                         for p in plan.get("pieces", []))
        cand_imgs = "".join(
            f"<figure><img src='{esc(f)}' loading='lazy'><figcaption>{esc(c['mode'])} a{c['attempt']} c{c['index']}: "
            f"combined {fmt(c.get('combined'))} {'PASS' if c.get('passed') else 'fail'}"
            f"{' (selected)' if (c['mode'], c['attempt'], c['index']) == (sel['mode'], sel['attempt'], sel['index']) else ''}"
            f"</figcaption></figure>" if f else
            f"<figure><figcaption class='bad'>render error: {esc(c.get('error', ''))}</figcaption></figure>"
            for c, f in zip(m["candidates"], r["candidate_files"]))
        warnings = "".join(f"<li>{esc(w)}</li>" for w in m.get("warnings", []))
        fixed = ", ".join(f"{e['type']} ({e.get('wall') or '?'})" for e in a.get("fixed_elements", []))
        cards.append(f"""
<section class='card'>
  <h2>{title} <span class='badge {'pass' if q['passed'] else 'fail'}'>{'PASSED' if q['passed'] else 'FLAGGED'}</span></h2>
  <div class='pair'><figure><img src='{esc(r['before'])}'><figcaption>Before</figcaption></figure>
  <figure><img src='{esc(r['after'])}'><figcaption>After (selected)</figcaption></figure></div>
  <p>fidelity <b>{fmt(q['fidelity'], 3)}</b> · judge <b>{fmt(q['judge_overall'])}</b> · combined <b>{fmt(q['combined'])}</b>
   · renders {q['renders']} · {r['seconds']} s · output size matches input: {'yes' if r['size_ok'] else 'NO'}</p>
  {f"<ul class='warn'>{warnings}</ul>" if warnings else ''}
  <div class='cols'><div><h3>Structural fidelity</h3>{_fidelity_table(chosen['fidelity'])}</div>
  <div><h3>Judge</h3>{_judge_table(chosen.get('judge'))}</div></div>
  <details><summary>Analysis</summary><p>{esc(a['room_type'])} (conf {fmt(a.get('room_type_confidence'))}), {esc(a['size_class'])},
   {esc(a['occupancy'])}; camera {esc(a.get('camera'))}; light {esc(a.get('lighting'))}; fixed: {esc(fixed)}</p></details>
  <details><summary>Plan ({len(plan.get('pieces', []))} pieces)</summary><ul>{pieces}</ul>
   <p class='muted'>Rug: {esc(plan.get('rug'))}</p><p class='muted'>Keep clear: {esc('; '.join(plan.get('keep_clear', [])))}</p></details>
  <details><summary>All candidates</summary><div class='grid'>{cand_imgs}</div></details>
  <details><summary>Final prompt</summary><pre>{esc((m.get('prompts') or [''])[-1])}</pre></details>
</section>""")
    return f"""<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>VirtueStage eval report</title>
<style>
:root{{--bg:#f8fafc;--fg:#0f172a;--muted:#64748b;--card:#fff;--line:#e2e8f0;--good:#15803d;--bad:#b91c1c}}
@media (prefers-color-scheme:dark){{:root{{--bg:#0b1120;--fg:#e2e8f0;--muted:#94a3b8;--card:#111827;--line:#1f2937;--good:#4ade80;--bad:#f87171}}}}
body{{font:14px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px;max-width:1400px;margin:auto}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:8px}} .pair img,.grid img{{width:100%;border-radius:6px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}}
.cols{{display:grid;grid-template-columns:1fr 1fr;gap:16px}} @media (max-width:800px){{.pair,.cols{{grid-template-columns:1fr}}}}
figure{{margin:0}} figcaption,.muted{{color:var(--muted);font-size:12px}} table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left}} .bad{{color:var(--bad)}} .warn{{color:#b45309}}
.badge{{font-size:12px;padding:2px 8px;border-radius:99px;color:#fff}} .badge.pass{{background:var(--good)}} .badge.fail{{background:var(--bad)}}
pre{{white-space:pre-wrap;font-size:12px}}
</style></head><body>
<h1>VirtueStage eval report</h1>
<p class='muted'>{esc(summary['created'])} · provider {esc(summary['provider'])} · render model {esc(summary['renderer_model'])} ·
vision model {esc(summary['vision_model'])} · mode {esc(summary['mode'])} · {summary['candidates']} candidates, {summary['max_retries']} retry round(s)</p>
{fake_note}
<p><b>{passed}/{len(ok)}</b> runs passed quality thresholds; {len(rows) - len(ok)} failed to run.
Thresholds are uncalibrated starting values; use the raw scores below to tune them.</p>
<table><tr><th>style</th><th>passed</th><th>mean fidelity</th><th>mean judge</th></tr>{style_rows}</table>
{''.join(cards)}
</body></html>"""


def main(argv=None):
    ap = argparse.ArgumentParser(description="Run the staging pipeline over a folder and write an HTML report")
    ap.add_argument("--images", required=True, help="folder of room photos")
    ap.add_argument("--styles", default="modern,coastal", help=f"comma-separated, from: {','.join(STYLE_KEYS)}")
    ap.add_argument("--provider", default="gemini", choices=["gemini", "openai", "fake"])
    ap.add_argument("--room-type", default="auto")
    ap.add_argument("--mode", default="stage", choices=MODES)
    ap.add_argument("--candidates", type=int, default=2)
    ap.add_argument("--max-retries", type=int, default=1)
    ap.add_argument("--gemini-model", default="gemini-flash")
    ap.add_argument("--vision-model", default="gemini-2.5-flash")
    ap.add_argument("--limit", type=int, help="only the first N images")
    ap.add_argument("--out", help="output folder (default eval/out/<timestamp>)")
    args = ap.parse_args(argv)

    styles = [s.strip() for s in args.styles.split(",") if s.strip()]
    bad = [s for s in styles if s not in STYLE_KEYS]
    if bad:
        ap.error(f"unknown style(s): {bad}")
    images = find_images(Path(args.images), args.limit)
    if not images:
        ap.error(f"no images found in {args.images}")
    out = Path(args.out) if args.out else ENGINE / "eval" / "out" / time.strftime("%Y%m%d-%H%M%S")
    rows, report = run_eval(images, styles, out, args.provider, args.room_type, args.mode, args.candidates,
                            args.max_retries, args.gemini_model, args.vision_model)
    failed = sum(1 for r in rows if "error" in r)
    print(f"\nReport: {report}  ({len(rows)} runs, {failed} errors)")
    return 1 if failed == len(rows) else 0


if __name__ == "__main__":
    sys.exit(main())
