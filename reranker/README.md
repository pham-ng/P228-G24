# Local cross-encoder reranker

Second-stage retrieval reranking that runs **fully offline** on the GPU, so the
kiosk needs no network. `server/rerank-local.ts` calls this over loopback; it is
the offline counterpart to `server/rerank-hf.ts` (which used the Hugging Face
Inference API). Model: `BAAI/bge-reranker-v2-m3` (fp16, ~1.25 GB VRAM).

Why a separate Python process: Ollama exposes bge-reranker only as single-text
embedding (`/api/embed`), which cannot score a `(query, passage)` PAIR — the one
thing a cross-encoder is for. This serves the real pair-scoring endpoint.

## Run

```bash
/opt/conda/bin/pip install -r reranker/requirements.txt
RERANK_PORT=11435 pm2 start reranker/rerank_server.py \
  --name aurea-rerank --interpreter /opt/conda/bin/python3
pm2 save
```

`transformers` is pinned `<4.47`: 5.x needs torch ≥ 2.5, and the box has 2.2.

## App configuration (`.env`)

The Node app must be told to use it, alongside the context/passage settings the
retrieval quality depends on:

```
# cross-encoder rerank (needs reranker/rerank_server.py running on 11435)
RERANK_ENABLED=1
RERANK_BACKEND=local          # local | hf | llm
RERANK_DEPTH=30               # pool depth — buried docs sit as deep as #17-21
RERANK_STRICT=1               # local-or-original-order; never fall back to the noisy LLM reranker
LOCAL_RERANK_BASE=http://127.0.0.1:11435

# feed the model enough of each passage (default 400 truncated answers mid-figure)
LOCAL_PASSAGE_CHAR_CAP=1200
LOCAL_NUM_CTX=8192            # NB: the code reads LOCAL_NUM_CTX, NOT LOCAL_CTX
```

Measured effect of the whole set on the Vietnamese golden: retrieval hit@5
85→100%, answer numeric accuracy 58→73%, with no rise in fabrication. See
`bench/` and the memory notes.

## Endpoints

- `GET /health` → `{status, model, device}`
- `POST /rerank` `{query, docs:[{id, text}]}` → `{scores:[{id, score}], ms}` — one
  batched forward pass over the whole pool.
