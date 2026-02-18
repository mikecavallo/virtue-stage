#!/bin/bash
# VirtueStage — Quick Deploy Script
# Usage: ./deploy.sh [port]
# Requires: Node.js 18+, Python 3.10+, GEMINI_API_KEY env var

set -e

PORT="${1:-3099}"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🏠 VirtueStage Deploy"
echo "===================="

# Check requirements
if ! command -v node &> /dev/null; then echo "❌ Node.js required"; exit 1; fi
if ! command -v python3 &> /dev/null; then echo "❌ Python3 required"; exit 1; fi
if [ -z "$GEMINI_API_KEY" ]; then
    echo "⚠️  GEMINI_API_KEY not set — staging won't work without it"
    echo "   Set it: export GEMINI_API_KEY=your_key"
fi

# Install backend deps
echo "📦 Installing backend dependencies..."
cd "$DIR/backend"
npm install --production 2>/dev/null

# Install Python deps
echo "🐍 Installing Python dependencies..."
pip3 install google-genai Pillow --quiet 2>/dev/null || pip install google-genai Pillow --quiet 2>/dev/null

# Build frontend
echo "🔨 Building frontend..."
cd "$DIR/website"
npm install 2>/dev/null
npx vite build

# Copy built frontend to backend static dir
echo "📁 Setting up static serving..."
rm -rf "$DIR/backend/public"
cp -r "$DIR/website/dist" "$DIR/backend/public"
# Copy sample images
cp -r "$DIR/website/public/images" "$DIR/backend/public/images" 2>/dev/null || true

# Create data directories
mkdir -p "$DIR/backend/data/uploads" "$DIR/backend/data/results"

echo ""
echo "✅ Build complete!"
echo ""
echo "To start:"
echo "  cd $DIR/backend"
echo "  GEMINI_API_KEY=your_key PORT=$PORT node server.js"
echo ""
echo "The app will serve at http://localhost:$PORT"
echo "Frontend is embedded — no separate dev server needed in production."
