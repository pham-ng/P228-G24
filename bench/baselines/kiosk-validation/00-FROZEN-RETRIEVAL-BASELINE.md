# Frozen retrieval baseline — 2026-08-24

Không thay đổi kiến trúc truy hồi trong phase này trừ khi một thí nghiệm đo được
chứng minh truy hồi là nguyên nhân gây lỗi. Mọi số liệu bên dưới lấy trực tiếp
từ `data.db` và `.env` tại thời điểm đóng băng, không suy đoán.

## Cấu hình

| Tham số | Giá trị | Nguồn |
|---|---|---|
| Embedding provider | `local` | `.env` |
| Embedding model | `bge-m3` | `.env` + `index_meta.model` |
| Embedding dimension | 1024 | `index_meta.dimension` |
| Embedding version (chuẩn hoá text) | `1` | `index_meta.embedding_version` |
| RRF_VEC_WEIGHT | 0.5 | `.env`, xác nhận tối ưu qua quét lại trên `data.db` |
| RRF_K | 60 | `server/retrieval.ts` |
| Chunk count | 138 | `index_meta.chunk_count`, khớp `vector_count` (không có chunk thiếu vector) |
| LOCAL_MIN_SCORE | 0.012 (mặc định code, `.env` không override) | `server/local-agent.ts:57` |
| LOCAL_PASSAGES (k truy hồi cho offline) | 5 | `server/local-agent.ts:83` |
| index_meta.created_at | 2026-08-24T09:33:15Z | lần reindex `bge-m3` cuối cùng |

## Kết quả đo đã có (không đo lại trong phase này trừ khi có lý do)

| | hit@1 | hit@5 | MRR | nDCG@5 | p50 |
|---|---:|---:|---:|---:|---:|
| Hybrid (BM25+bge-m3+RRF) | 92.3% | 98.1% | 0.954 | 87.2% | 95ms |
| + HyDE | 92.3% | 98.1% | 0.954 | 87.2% | 451ms (không cải thiện, giữ tắt) |
| + LLM Rerank | 92.3% | 98.1% | 0.954 | 87.2% | 316ms (không cải thiện, giữ tắt) |
| + Cross-encoder thật (`bge-reranker-v2-m3`) | 90.4% | 98.1% | 0.940 | 83.4% | 1914ms (làm TỆ hơn, giữ tắt) |
| Đa ngữ (zh/ja/ko) hit@5 | 6/6 mỗi ngôn ngữ | | 0.983 | | |

Nguồn: `bench/baselines/remediation/02-retrieval-after-FINAL.json`,
`07-ablation-bgem3.json`, `08-crossencoder-hf.txt`.

## Điều CHƯA đo trong baseline này

- Chưa đo lại với bộ test 150-200 case (đang xây ở Part 3).
- `LOCAL_MIN_SCORE=0.012` là giá trị kế thừa từ thời BM25-only, **chưa hiệu
  chỉnh lại theo phân phối điểm của `bge-m3`** — đây là việc Part 2 xử lý.

## Cam kết

File này là điểm neo. Nếu bất kỳ tham số nào ở trên bị sửa trong các phase
sau, phải ghi lại tại đây kèm lý do và số đo trước/sau — không sửa âm thầm.
