# ── Build stage: install Python dependencies ───────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /app

# Install build tools needed for native extensions (scipy, numpy, etc.) and git for pip VCS installs
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ git && \
    rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY backend/ ./backend/
COPY example_datasets/ ./example_datasets/

# Run as a non-root user; /tmp (used for uploads/job scratch dirs) stays writable
# since it's world-writable with the sticky bit set.
RUN useradd --create-home --shell /usr/sbin/nologin appuser && \
    chown -R appuser:appuser /app
USER appuser

# Run uvicorn from the backend directory so Python resolves 'main:app' directly,
# avoiding namespace-package issues with 'backend.main:app' from /app.
WORKDIR /app/backend

EXPOSE 8080

# Single worker: JOBS/cancel state is in-memory and must live in one process.
# FastAPI is async so concurrent API requests are handled without extra workers;
# encoding runs in background threads and doesn't block the event loop.
# Shell form so the platform-injected $PORT (Cloud Run / Railway / Render) is honoured,
# falling back to 8080 for local runs.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --loop uvloop"]