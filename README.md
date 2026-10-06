# VirtueStage

AI virtual staging for real estate photos: upload a photo of an empty room, pick a design style, and get back a furnished version.
Aimed at listing agents who want staged photos without paying for physical staging.

![Before/after result in demo mode](docs/screenshots/result.png)

## What it does

1. **Sign up** and get 3 free staging credits (email + password, JWT auth).
2. **Upload** a room photo, choose a room type (or auto-detect) and one of eight styles:
   modern, traditional, minimalist, bohemian, scandinavian, luxury, coastal, farmhouse.
   Optionally ask for existing furniture/clutter to be removed first.
3. The Python engine analyzes the room, plans the furniture, renders candidates with Google
   Gemini's image model, scores them and keeps the best one (see [How staging works](#how-staging-works)).
4. **Compare** before and after with a drag slider, download the result (with a "Virtually Staged"
   disclosure label by default), or re-stage the same photo in another style. A credit is only
   deducted when a job succeeds.
5. **Multi-angle projects**: stage a hero shot first, then upload other angles of the same room;
   each is staged with the hero result as a reference image and the hero's saved furniture plan,
   so the same pieces appear in every angle.

| Configure | Dashboard |
|---|---|
| ![Configure staging](docs/screenshots/configure.png) | ![Dashboard](docs/screenshots/dashboard.png) |

Screenshots were taken from the running app in **demo mode**, where the "after" image is a bundled
sample (labeled as such) rather than a real generation from the uploaded photo.

## Architecture

```
website/   React 19 + Vite SPA (landing page, auth, dashboard, upload/compare UI)
backend/   Express 5 API: auth (bcrypt + JWT), credits, uploads (multer), thumbnails (sharp),
           SQLite via better-sqlite3; serves the built SPA from backend/public in production
engine/    Python staging engine the backend spawns per job:
             virtual_stager.py  CLI entry point (backend contract)
             staging/           analysis, planner, prompts, providers, fidelity, judge, selection,
                                watermark, pipeline; styles.json (shared with the backend)
             eval/              batch evaluation harness with an HTML report
             detect_room.py     Gemini vision room-type classification (used for "auto")
```

Request flow: `POST /api/staging/upload` stores the photo, inserts a `processing` job and spawns
`engine/virtual_stager.py`. The frontend polls `/api/staging/status/:jobId`; when the engine exits,
the backend moves the output and its metadata JSON into `data/results/<user>/`, makes thumbnails,
marks the job `complete` and deducts one credit. Image URLs in API responses carry a short-lived, image-only token
so plain `<img>` tags can load them.

## How staging works

```
photo ──> [1 analyze] ──> [2 declutter]* ──> [3 plan] ──> [4 render x N] ──> [5 verify] ──> [6 select] ──> result
          vision model     image model        rules +      image model,      fidelity     best passing
          (JSON): room     removes existing   style        constrained       (numpy) +    candidate; if
          type, camera,    furniture          preset       edit prompt,      vision judge none passes,
          light, fixed     (*optional mode)                aspect ratio      rubric       one retry with
          elements, size,                                  kept, output at   (JSON)       the feedback
          occupancy                                        input size
```

1. **Analyze.** A Gemini text+image call with a JSON schema returns room type and confidence, camera
   height/angle/vanishing direction, light sources with direction and color temperature, every fixed
   element (windows, doors, outlets, vents, radiators, built-ins, fixtures) with its wall and bounding
   box, flooring and wall color, walkable floor, traffic paths, size class and whether the room is
   empty, partially furnished or cluttered.
2. **Declutter** (optional, `declutter_stage` mode). Removes existing furniture first, keeping the
   architecture, then stages the emptied room. `declutter` mode stops after emptying.
3. **Plan.** Deterministic rules turn analysis + style into a furniture list: fewer and smaller
   pieces in small rooms, wall-anchored pieces never on a wall with a door/closet/stairs, tall
   pieces never against windows or radiators, the bed on a solid headwall, rug sizes per room type,
   dining tables sized to the room with 36 in clearance, kitchens and bathrooms styled lightly only.
   Eight presets in `engine/staging/styles.json` give each style a palette, materials, a specific
   description for every furniture category and a list of things to avoid.
4. **Render.** The edit prompt carries an explicit keep-identical list (walls, wall color, windows,
   doors, floor, ceiling, fixtures, camera angle, perspective, framing), camera/scale and lighting
   instructions (contact shadows, light direction), the plan, keep-clear areas and MLS rules (no
   people, pets, text or logos). The closest supported aspect ratio is requested from Gemini; the
   output is cropped/padded back and resized to the exact input width and height.
5. **Verify.** Each candidate (default 2) gets a structural-fidelity score comparing input and
   output only where nothing should change (top band of the frame plus the window/door/fixture
   boxes from the analysis): SSIM, edge-map F1 and color shift after a small alignment search. A
   vision-model judge scores photorealism, scale, perspective, lighting match, architecture
   preserved, MLS appropriateness and style match (0-10, JSON).
6. **Select.** The best passing candidate wins. If none passes, one more round runs with the
   judge's issues and the failed regions appended to the prompt; if that also fails, the best
   candidate is returned and flagged. Analysis, plan, prompts and every score are saved as JSON
   next to the output, and the app shows a short quality summary.

**Status, honestly:** every step is unit-tested with a fake provider (prompt construction, plan
rules, aspect-ratio restore, fidelity scoring on synthetic rooms, selection, retries, watermark,
CLI and backend contract), and the Gemini request shapes are checked against the real SDK types.
The pipeline has **not yet been run against the live Gemini API** in this repository's
development environment (no key there), so output quality has not been measured and the score
thresholds are uncalibrated starting values. The evaluation harness exists for exactly that:

```bash
cd engine
pip install -r requirements.txt
export GEMINI_API_KEY=...
python -m eval.run --images eval/samples --styles modern,coastal
# open the printed eval/out/<timestamp>/report.html
```

The report shows before/after pairs, every candidate, the fidelity regions and the judge scores, so
prompts and thresholds can be tuned on real output.

## Running locally

Requirements: Node.js 22.9+. For real staging also Python 3.10+ and a Gemini API key.

### Demo mode (no API key)

```bash
cd backend && npm install
cd ../website && npm install && npm run build && rm -rf ../backend/public && cp -r dist ../backend/public
cd ../backend && STAGING_MODE=demo JWT_SECRET=dev npm start
# open http://localhost:3099
```

In demo mode no model is called and Python is not needed. Each job waits ~1.5 s and returns a
bundled sample image with a "DEMO MODE SAMPLE" label, and the dashboard shows a demo notice.
Auth, credits, uploads, thumbnails, re-staging and downloads all run for real.

### Real staging with Gemini

```bash
pip install -r engine/requirements.txt
cp backend/.env.example backend/.env   # set STAGING_MODE=gemini, GEMINI_API_KEY, JWT_SECRET
cd backend && npm start                # API on :3099
cd website && npm run dev              # Vite dev server on :5173, proxies /api to :3099
```

### Docker / Railway

`Dockerfile` builds one image with the API, the built frontend and the Python engine;
`railway.json` points Railway at it and health-checks `/api/health`. Set `JWT_SECRET`,
`GEMINI_API_KEY` (or `STAGING_MODE=demo`) and mount a volume at `DATA_DIR` (default
`/app/backend/data`) so the database and images survive redeploys. `deploy.sh` does the same
build without Docker.

## Environment variables (backend)

| Variable | Default | Purpose |
|---|---|---|
| `STAGING_MODE` | `gemini` | `demo` returns bundled samples instead of calling the engine |
| `GEMINI_API_KEY` | | Required for `gemini` mode (`GOOGLE_API_KEY` also accepted) |
| `GEMINI_IMAGE_MODEL` | `gemini-flash` | `gemini-flash` (`gemini-2.5-flash-image`), `gemini-pro`, or a full model id |
| `GEMINI_VISION_MODEL` | `gemini-2.5-flash` | Model for room analysis and the quality judge |
| `STAGING_CANDIDATES` | `2` | Renders per round (cost scales with this) |
| `STAGING_MAX_RETRIES` | `1` | Extra rounds with judge feedback when no candidate passes |
| `DISCLOSURE_WATERMARK` | `on` | "Virtually Staged" label on downloads; `?disclosure=0/1` overrides per download |
| `JWT_SECRET` | random per start | Set it, or every restart logs all users out |
| `PORT` | `3099` | HTTP port |
| `DATA_DIR` | `backend/data` | SQLite DB, uploads, results, thumbnails |
| `PYTHON_BIN` | `python3` | Interpreter used to run the engine |
| `DEMO_DELAY_MS` | `1500` | Simulated processing time in demo mode |

See `backend/.env.example`.

## Scripts and tests

| Where | Command | What |
|---|---|---|
| `backend/` | `npm start` / `npm run demo` | Run the API (loads `backend/.env` if present) |
| `backend/` | `npm test` | node:test + supertest: auth, credits, upload/restage flow, access control, disclosure label (demo engine), plus a contract test that runs the real Python engine with its fake provider |
| `engine/` | `python -m pytest` | Offline tests (no keys): plan rules, prompts, aspect ratio, fidelity scorer, judge/selection, pipeline, CLI, eval harness |
| `engine/` | `python -m eval.run --images DIR --styles a,b` | Full pipeline over a folder, HTML report (needs `GEMINI_API_KEY`; `--provider fake` to test offline) |
| `website/` | `npm run dev` / `npm run build` / `npm run lint` | Vite dev server, production build, ESLint |

CI (`.github/workflows/ci.yml`) runs the backend tests (including the engine contract test), the
website lint and build, and the engine's pytest suite on every push and pull request. No API keys
are used in CI.

## Status

Working: auth, free credits, single-photo staging, auto room detection, re-staging, downloads with
a disclosure label, multi-angle projects, declutter-then-stage mode, demo mode, Docker build config.
The staging pipeline is tested offline only; see the status note in [How staging works](#how-staging-works).

Not implemented yet:
- **Payments.** The Pro plan on the pricing page is marked "coming soon"; there is no Stripe or
  other billing integration, and `plan` is always `free`.
- Password reset, email verification, and rate limiting beyond 3 concurrent jobs per user.
- Score thresholds calibrated on real model output (needs an eval run with a Gemini key).
- Image storage is local disk; there is no object storage or cleanup policy.

Early business planning notes (market research, pricing ideas) live in `docs/planning/` and are
not product metrics.

## License

No license has been chosen yet, so all rights are reserved by the author.
