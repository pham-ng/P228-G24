"""
Local cross-encoder reranker for Aurea — BAAI/bge-reranker-v2-m3 on the GPU.

Replaces the Hugging Face Inference API path (server/rerank-hf.ts) with a
100%-offline local service so the kiosk keeps working with no network. One
batched forward pass scores every (query, passage) pair at once — far faster
than the HF path's one-call-per-candidate.

Deterministic: eval mode, no_grad, fp16, fixed truncation. Same (query, passage)
pair always yields the same score.

  POST /rerank  {"query": "...", "docs": [{"id": 0, "text": "..."}, ...]}
        -> {"scores": [{"id": 0, "score": 0.87}, ...], "ms": 42}
  GET  /health -> {"status":"ok","model":...,"device":...}

Run:  RERANK_PORT=11435 /opt/conda/bin/python3 rerank_server.py
"""
import os
import time

import torch
from flask import Flask, jsonify, request
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_NAME = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
PORT = int(os.environ.get("RERANK_PORT", "11435"))
MAX_LEN = int(os.environ.get("RERANK_MAX_LEN", "512"))
MAX_BATCH = int(os.environ.get("RERANK_MAX_BATCH", "64"))

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32

print(f"[rerank] loading {MODEL_NAME} on {device} ({dtype}) ...", flush=True)
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, torch_dtype=dtype)
model.to(device).eval()
print("[rerank] ready", flush=True)

app = Flask(__name__)


@torch.no_grad()
def score_pairs(query, texts):
    """Return a relevance score in [0,1] for each (query, text). Batched."""
    out = []
    for start in range(0, len(texts), MAX_BATCH):
        batch = texts[start : start + MAX_BATCH]
        pairs = [[query, t] for t in batch]
        enc = tokenizer(
            pairs, padding=True, truncation=True, max_length=MAX_LEN, return_tensors="pt"
        ).to(device)
        logits = model(**enc, return_dict=True).logits.view(-1).float()
        out.extend(torch.sigmoid(logits).tolist())
    return out


@app.get("/health")
def health():
    return jsonify(status="ok", model=MODEL_NAME, device=device)


@app.post("/rerank")
def rerank():
    body = request.get_json(force=True, silent=True) or {}
    query = body.get("query") or ""
    docs = body.get("docs") or []
    if not query or not docs:
        return jsonify(scores=[], ms=0)
    t0 = time.time()
    texts = [str(d.get("text") or "") for d in docs]
    scores = score_pairs(query, texts)
    result = [{"id": d.get("id"), "score": s} for d, s in zip(docs, scores)]
    return jsonify(scores=result, ms=int((time.time() - t0) * 1000))


if __name__ == "__main__":
    # threaded=False: one GPU, serialise requests — deterministic and avoids
    # CUDA contention. The Node caller already limits concurrency.
    app.run(host="127.0.0.1", port=PORT, threaded=False)
