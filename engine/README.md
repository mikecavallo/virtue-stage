# VirtueStage engine

Python scripts the backend runs as subprocesses.

| Script | Purpose |
|---|---|
| `virtual_stager.py` | Stages one room photo. Writes `<stem>_staged_<style>_<provider><ext>` next to the input. |
| `detect_room.py` | Classifies the room type (living room, bedroom, ...) with Gemini vision. Prints JSON. |

## Providers

- **Gemini** (default, used by the backend). Needs `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).
  Model is set with `--gemini-model` or `GEMINI_IMAGE_MODEL`: `gemini-flash`
  (`gemini-2.5-flash-image`, default), `gemini-pro` (`gemini-3-pro-image-preview`),
  or any full Gemini model id.
- **OpenAI gpt-image-1** (optional, CLI only). Needs `OPENAI_API_KEY` and `pip install openai`.

## Usage

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=...
python3 virtual_stager.py path/to/empty-room.jpg --style scandinavian
```

The backend passes its own detailed prompt via `--prompt` (see `buildStagingPrompt`
in `backend/server.js`) and, for multi-angle projects, a staged hero shot via
`--reference-image`.

For running the app without any API key, use the backend's demo mode
(`STAGING_MODE=demo`), which bypasses this engine entirely.
