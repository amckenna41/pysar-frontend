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

# Run uvicorn from the backend directory so Python resolves 'main:app' directly,
# avoiding namespace-package issues with 'backend.main:app' from /app.
WORKDIR /app/backend

EXPOSE 8080

# Use exec form directly — avoids shell variable expansion issues in Cloud Run.
# Cloud Run always routes traffic to port 8080, so hard-coding it is correct.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]