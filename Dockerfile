# Single image: Express API + built React frontend + Python staging engine.
# Layout inside the image mirrors the repo: /app/backend, /app/engine, /app/website.
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python engine deps
COPY engine/requirements.txt engine/requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r engine/requirements.txt

# Backend deps (production only)
COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev

# Frontend build
COPY website/package*.json website/
RUN cd website && npm ci
COPY website/ website/
RUN cd website && npx vite build

# Backend source + engine, then serve the built frontend from backend/public
COPY backend/ backend/
COPY engine/ engine/
RUN rm -rf backend/public && cp -r website/dist backend/public

# SQLite DB, uploads and results. Mount a volume here (or set DATA_DIR) to persist them.
ENV NODE_ENV=production \
    DATA_DIR=/app/backend/data
RUN mkdir -p /app/backend/data

EXPOSE 3099
WORKDIR /app/backend
CMD ["node", "server.js"]
