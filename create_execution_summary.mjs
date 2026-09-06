import fs from 'fs';
import path from 'path';

const metrics = JSON.parse(fs.readFileSync('./artifacts/metric_results.json', 'utf-8'));
const manifest = JSON.parse(fs.readFileSync('./artifacts/baseline_manifest.json', 'utf-8'));

const summary = {
  timestamp: new Date().toISOString(),
  manifest_summary: {
    system: manifest.system,
    model: manifest.model_name,
    embedding: manifest.embedding_model,
    benchmark_hash: manifest.benchmark_hash
  },
  execution_summary: metrics.execution_accounting,
  overall_performance: metrics.overall_performance,
  core_ragas_metrics: metrics.core_metrics,
  diagnostic_metrics: metrics.diagnostic_metrics,
  evidence_to_answer_conversion: metrics.evidence_to_answer_conversion,
  matrix: metrics.matrix
};

fs.writeFileSync('./artifacts/execution_summary.json', JSON.stringify(summary, null, 2), 'utf-8');
console.log('Saved artifacts/execution_summary.json successfully!');
