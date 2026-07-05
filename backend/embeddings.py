"""
Protein language-model embeddings strategy (feature 5).

ESM-2 / ProtT5 embeddings need `torch` + `transformers` plus a multi-GB model download,
which the default lightweight container deliberately omits. This module therefore treats
those as OPTIONAL dependencies: everything degrades gracefully when they're absent, and
the API surfaces availability so the UI can gate the strategy instead of erroring mid-job.

To enable in a deployment, install the extras and set ESM_MODEL (default facebook/esm2_t6_8M_UR50D,
the smallest ESM-2 checkpoint) — or a larger checkpoint if the host has the RAM/VRAM:

    pip install "torch>=2.2" "transformers>=4.40"
"""
from __future__ import annotations

import functools
import os
from typing import List

import numpy as np

# Curated shortlist shown in the UI. Small default so a modest host can run it.
SUPPORTED_MODELS = [
    "facebook/esm2_t6_8M_UR50D",
    "facebook/esm2_t12_35M_UR50D",
    "facebook/esm2_t30_150M_UR50D",
    "Rostlab/prot_t5_xl_half_uniref50-enc",
]
DEFAULT_MODEL = os.environ.get("ESM_MODEL", "facebook/esm2_t6_8M_UR50D")

# Cap batch/length so an accidental huge request can't OOM the host.
_MAX_SEQS = 2000
_MAX_LEN = 1024


@functools.lru_cache(maxsize=1)
def embeddings_available() -> bool:
    """True when torch + transformers import successfully (optional deps present)."""
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        return True
    except Exception:
        return False


def status() -> dict:
    """Availability payload for GET /api/embeddings/status and the UI gate."""
    return {
        "available": embeddings_available(),
        "default_model": DEFAULT_MODEL,
        "models": SUPPORTED_MODELS,
        "reason": None if embeddings_available()
                  else "torch/transformers not installed on this backend.",
    }


@functools.lru_cache(maxsize=2)
def _load(model_name: str):
    """Load and cache a tokenizer + model. Cached so repeat jobs don't re-download."""
    import torch
    from transformers import AutoModel, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_name)
    model = AutoModel.from_pretrained(model_name)
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    return tok, model, device


def embed_sequences(sequences: List[str], model_name: str = DEFAULT_MODEL,
                    batch_size: int = 8) -> np.ndarray:
    """Return a mean-pooled per-sequence embedding matrix (n_sequences x hidden_dim).

    Raises RuntimeError if the optional deps are missing so callers can surface a clear
    message rather than a stack trace.
    """
    if not embeddings_available():
        raise RuntimeError(
            "Embedding strategy requires torch + transformers, which are not installed "
            "on this backend. See backend/embeddings.py for enablement steps."
        )
    if not sequences:
        raise ValueError("No sequences to embed.")
    if len(sequences) > _MAX_SEQS:
        raise ValueError(f"Too many sequences for embedding (max {_MAX_SEQS}).")

    import torch

    tok, model, device = _load(model_name)
    # ProtT5 expects space-separated residues; ESM does not. Detect by name.
    is_t5 = "t5" in model_name.lower()
    vecs: List[np.ndarray] = []
    for start in range(0, len(sequences), batch_size):
        batch = [s[:_MAX_LEN] for s in sequences[start:start + batch_size]]
        if is_t5:
            batch = [" ".join(list(s)) for s in batch]
        enc = tok(batch, return_tensors="pt", padding=True, truncation=True, max_length=_MAX_LEN)
        enc = {k: v.to(device) for k, v in enc.items()}
        with torch.no_grad():
            out = model(**enc)
        hidden = out.last_hidden_state            # (B, L, H)
        mask = enc["attention_mask"].unsqueeze(-1)  # (B, L, 1)
        summed = (hidden * mask).sum(dim=1)
        counts = mask.sum(dim=1).clamp(min=1)
        mean_pooled = (summed / counts).cpu().numpy()
        vecs.append(mean_pooled)
    return np.vstack(vecs)
