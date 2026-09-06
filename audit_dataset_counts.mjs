import fs from 'fs';

// Helper CSV parser
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const header = lines[0].split(',').map(c => c.replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Basic CSV splitting handling simple quotes
    const raw = lines[i];
    if (!raw) continue;
    const cells = [];
    let insideQuote = false;
    let currentCell = '';
    for (let j = 0; j < raw.length; j++) {
      const char = raw[j];
      if (char === '"') {
        insideQuote = !insideQuote;
      } else if (char === ',' && !insideQuote) {
        cells.push(currentCell.replace(/^"|"$/g, '').replace(/""/g, '"'));
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    cells.push(currentCell.replace(/^"|"$/g, '').replace(/""/g, '"'));
    
    const rowObj = {};
    header.forEach((h, idx) => {
      rowObj[h] = cells[idx] ?? '';
    });
    rows.push(rowObj);
  }
  return rows;
}

const files = [
  { name: 'Golden Dataset', file: 'golden_dataset_vi.csv' },
  { name: 'Diagnostic Dataset', file: 'diagnostic_dataset_vi.csv' },
  { name: 'Real User Dataset', file: 'real_user_dataset_vi.csv' },
  { name: 'Regression Dataset', file: 'regression_dataset_vi.csv' }
];

console.log('=== DATASET & 300-CASE AUDIT ===');
const allUniqueIds = new Set();
let totalAnswerable = 0;
let totalUnanswerable = 0;
let totalAmbiguous = 0;
let totalAdversarial = 0;
let totalMultiTurn = 0;

files.forEach(f => {
  if (fs.existsSync(f.file)) {
    const rows = parseCSV(fs.readFileSync(f.file, 'utf-8'));
    const ids = rows.map(r => r.id);
    const uniqueIds = new Set(ids);
    rows.forEach(r => {
      allUniqueIds.add(r.id);
      if (r.answerability === 'ANSWERABLE') totalAnswerable++;
      else if (r.answerability === 'UNANSWERABLE' || r.answerability === 'OUT_OF_SCOPE') totalUnanswerable++;
      else if (r.answerability === 'AMBIGUOUS') totalAmbiguous++;
      
      if (r.difficulty === 'adversarial' || r.category?.includes('TRAP')) totalAdversarial++;
    });
    console.log(`${f.name} (${f.file}):`);
    console.log(`  Rows: ${rows.length}`);
    console.log(`  Unique IDs: ${uniqueIds.size}`);
    console.log(`  Duplicates: ${rows.length - uniqueIds.size}`);
  } else {
    console.log(`${f.name} (${f.file}): NOT_VERIFIED`);
  }
});

console.log('\n=== COMBINED UNIQUE CASES METRICS ===');
console.log(`Total Combined Unique Test Case IDs: ${allUniqueIds.size}`);
console.log(`Total Answerable across files: ${totalAnswerable}`);
console.log(`Total Unanswerable/Out-of-KB: ${totalUnanswerable}`);
console.log(`Total Ambiguous: ${totalAmbiguous}`);
console.log(`Total Adversarial: ${totalAdversarial}`);
