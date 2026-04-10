"""
Vercel Serverless Function entry point.
Wraps the existing FastAPI app so all /api/* routes are handled.
"""
import sys
from pathlib import Path

# Ensure the backend package and pySAR repo root are importable
_THIS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_THIS_DIR / "backend"))
sys.path.insert(0, str(_THIS_DIR.parent))  # pySAR repo root

from backend.main import app  # noqa: E402 — FastAPI app instance

# Vercel expects a variable named `app` (ASGI) or `handler` (WSGI).
# FastAPI is ASGI, so exporting `app` is sufficient.
