#!/usr/bin/env bash
# Build VirtueStage for a single-process deployment without Docker:
# installs dependencies, builds the frontend into backend/public, and prints
# the start command. Requires Node.js 22.9+ and (for real staging) Python 3.10+.
set -euo pipefail

PORT="${1:-3099}"
DIR="$(cd "$(dirname "$0")" && pwd)"

command -v node >/dev/null || { echo "Node.js is required"; exit 1; }

echo "Installing backend dependencies..."
(cd "$DIR/backend" && npm ci --omit=dev)

if [ "${STAGING_MODE:-gemini}" != "demo" ]; then
  command -v python3 >/dev/null || { echo "python3 is required (or set STAGING_MODE=demo)"; exit 1; }
  echo "Installing Python engine dependencies..."
  python3 -m pip install -r "$DIR/engine/requirements.txt"
  [ -n "${GEMINI_API_KEY:-}" ] || echo "Warning: GEMINI_API_KEY is not set; staging will fail until it is."
fi

echo "Building frontend..."
(cd "$DIR/website" && npm ci && npx vite build)
rm -rf "$DIR/backend/public"
cp -r "$DIR/website/dist" "$DIR/backend/public"

echo
echo "Build complete. Start with:"
echo "  cd $DIR/backend && PORT=$PORT JWT_SECRET=... ${STAGING_MODE:+STAGING_MODE=$STAGING_MODE }node server.js"
echo "Then open http://localhost:$PORT"
