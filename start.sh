#!/usr/bin/env bash
# start.sh — launch the pySAR frontend (backend + frontend) in one command
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# On macOS, forking after numpy/BLAS/Objective-C libraries are loaded can cause
# SIGSEGV (exit code -11) in the encoding subprocess due to Apple's fork-safety
# mechanism. This env var disables that check for the server process and its children.
if [[ "$(uname)" == "Darwin" ]]; then
  export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
fi
# ── Kill both child processes on Ctrl-C ──────────────────────────────────────
cleanup() {
  echo ""
  echo "Shutting down..."
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Backend (FastAPI + uvicorn) ───────────────────────────────────────────────
echo "Starting FastAPI backend on http://localhost:8000 ..."
cd "$SCRIPT_DIR"
uvicorn backend.main:app --reload --port 8000 &
BACKEND_PID=$!

# Brief pause so the API is ready before the browser opens
sleep 1

# ── Frontend (Vite dev server) ────────────────────────────────────────────────
echo "Starting Vite dev server on http://localhost:5173 ..."
cd "$SCRIPT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "pySAR frontend running:"
echo "  UI  → http://localhost:5173"
echo "  API → http://localhost:8000/docs"
echo ""
echo "Press Ctrl-C to stop both servers."

# ── Wait for either process to exit ──────────────────────────────────────────
wait "$BACKEND_PID" "$FRONTEND_PID"
