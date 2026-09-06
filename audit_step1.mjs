import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const artifacts = [
  'golden_dataset_vi.xlsx',
  'golden_dataset_vi.csv',
  'diagnostic_dataset_vi.xlsx',
  'diagnostic_dataset_vi.csv',
  'real_user_dataset_vi.xlsx',
  'real_user_dataset_vi.csv',
  'regression_dataset_vi.xlsx',
  'regression_dataset_vi.csv',
  'evaluation_results.csv',
  'failure_cases.csv',
  'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\6932c736-da72-445c-b25a-a32638d20a3b\\evaluation_report.md',
  'coverage_matrix.md',
  'benchmark_design.md',
  'candidate_dataset_vi.xlsx'
];

console.log('=== STEP 1 ARTIFACT VERIFICATION ===');
artifacts.forEach(art => {
  const p = path.resolve(art);
  if (fs.existsSync(p)) {
    const stat = fs.statSync(p);
    const buf = fs.readFileSync(p);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const lines = buf.toString().split('\n').length;
    console.log(`ARTIFACT: ${art}`);
    console.log(`ACTUAL_PATH: ${p}`);
    console.log(`EXISTS: TRUE`);
    console.log(`FILE_SIZE: ${stat.size} bytes`);
    console.log(`MODIFIED_TIME: ${stat.mtime.toISOString()}`);
    console.log(`ROW_COUNT: ${lines}`);
    console.log(`HASH: ${hash}`);
    console.log(`STATUS: VERIFIED\n`);
  } else {
    console.log(`ARTIFACT: ${art}`);
    console.log(`ACTUAL_PATH: ${p}`);
    console.log(`EXISTS: FALSE`);
    console.log(`STATUS: NOT_VERIFIED\n`);
  }
});
