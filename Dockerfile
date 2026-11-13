# Build the TypeScript frontend
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY scripts/build_tactics_wasm.sh /scripts/build_tactics_wasm.sh
RUN npm run build

# Python API + Stockfish
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends stockfish \
    && rm -rf /var/lib/apt/lists/*
# Hosting defaults (2 vCPU). Engine cache goes to /tmp: hosts like Hugging
# Face Spaces run the container as a non-root user that can't write to /app.
ENV STOCKFISH_PATH=/usr/games/stockfish PYTHONUNBUFFERED=1 \
    WF_CACHE=/tmp/wf-cache WF_ENGINE_WORKERS=2 WF_MAX_GAMES=150 WF_ENGINE_DEPTH=8
WORKDIR /app
COPY requirements.txt .
# sentence-transformers (the coach's search_games tool) needs PyTorch: install
# the CPU-only build first, or pip pulls the multi-gigabyte CUDA build from PyPI.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
COPY wf/ wf/
COPY server.py .
COPY web/index.html web/style.css web/example_report.json web/
COPY --from=web /web/dist web/dist
EXPOSE 8080
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
