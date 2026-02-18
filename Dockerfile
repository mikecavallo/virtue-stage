FROM node:22-slim

# Install Python for staging engine
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
RUN python3 -m pip install --break-system-packages google-genai Pillow

# Install backend deps
COPY backend/package*.json backend/
RUN cd backend && npm install --production

# Install frontend deps and build
COPY website/package*.json website/
RUN cd website && npm install

COPY website/ website/
RUN cd website && npx vite build

# Copy built frontend to backend
RUN cp -r website/dist backend/public && \
    cp -r website/public/images backend/public/images 2>/dev/null || true

# Copy backend source and engine
COPY backend/ backend/
COPY engine/ engine/

# Create data dirs
RUN mkdir -p backend/data/uploads backend/data/results backend/data/thumbnails

EXPOSE 3099

WORKDIR /app/backend
CMD ["node", "server.js"]
