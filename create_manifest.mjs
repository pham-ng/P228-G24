import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const artifactsDir = './artifacts';
if (!fs.existsSync(artifactsDir)) fs.mkdirSync(artifactsDir, { recursive: true });

const benchmarkCsv = fs.readFileSync('./final_benchmark_vi.csv', 'utf-8');
const benchmarkHash = crypto.createHash('sha256').update(benchmarkCsv).digest('hex');

const manifest = {
  timestamp: new Date().toISOString(),
  system: 'Aurea AI Concierge Production Baseline',
  model_name: 'qwen3.5:4b',
  embedding_model: 'BAAI/bge-m3 (1024 dim)',
  retrieval_configuration: {
    hybrid_search: 'BM25 + BGE-M3 (RRF K=60)',
    top_k: 5,
    min_score: 0.005,
    passage_char_cap: 700,
    context_window: 4096
  },
  kb_version: 'Canonical Facts Commit 2026-08-30 (136 SQLite Chunks)',
  benchmark_file: 'final_benchmark_vi.csv',
  benchmark_hash: benchmarkHash,
  immutability_status: 'STRICT_BASELINE_LOCKED'
};

fs.writeFileSync(path.join(artifactsDir, 'baseline_manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
console.log('Saved artifacts/baseline_manifest.json successfully!');
