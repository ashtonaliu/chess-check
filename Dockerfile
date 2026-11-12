# Build the TypeScript frontend
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
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
# PyTorch is only used by the offline model benchmark, not by the web app,
# so it is left out of the image (saves ~800 MB).
RUN grep -v '^torch' requirements.txt > /tmp/req.txt \
    && pip install --no-cache-dir -r /tmp/req.txt
COPY wf/ wf/
COPY server.py .
COPY web/index.html web/style.css web/example_report.json web/
COPY --from=web /web/dist web/dist
EXPOSE 8080
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
