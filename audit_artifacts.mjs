import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const files = [
  { name: 'golden_dataset_vi.xlsx', path: './golden_dataset_vi.xlsx' },
  { name: 'golden_dataset_vi.csv', path: './golden_dataset_vi.csv' },
  { name: 'diagnostic_dataset_vi.xlsx', path: './diagnostic_dataset_vi.xlsx' },
  { name: 'diagnostic_dataset_vi.csv', path: './diagnostic_dataset_vi.csv' },
  { name: 'real_user_dataset_vi.xlsx', path: './real_user_dataset_vi.xlsx' },
  { name: 'real_user_dataset_vi.csv', path: './real_user_dataset_vi.csv' },
  { name: 'regression_dataset_vi.xlsx', path: './regression_dataset_vi.xlsx' },
  { name: 'regression_dataset_vi.csv', path: './regression_dataset_vi.csv' },
  { name: 'evaluation_results.csv', path: './evaluation_results.csv' },
  { name: 'failure_cases.csv', path: './failure_cases.csv' },
  { name: 'evaluation_report.md', path: 'C:\\Users\\Administrator\\.gemini\\antigravity\\brain\\6932c736-da72-445c-b25a-a32638d20a3b\\evaluation_report.md' }
];

console.log('=== FILE EXISTENCE AUDIT ===');
files.forEach(f => {
  const fullPath = path.resolve(f.path);
  if (fs.existsSync(fullPath)) {
    const stats = fs.statSync(fullPath);
    const buf = fs.readFileSync(fullPath);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const lines = buf.toString().split('\n').length;
    console.log(`FILE: ${f.name}`);
    console.log(`EXISTS: TRUE`);
    console.log(`SIZE: ${stats.size} bytes`);
    console.log(`MODIFIED_TIME: ${stats.mtime.toISOString()}`);
    console.log(`ROW_COUNT: ${lines}`);
    console.log(`SHA256: ${sha}`);
    console.log(`ACTUAL_PATH: ${fullPath}\n`);
  } else {
    console.log(`FILE: ${f.name}`);
    console.log(`EXISTS: FALSE\n`);
  }
});
