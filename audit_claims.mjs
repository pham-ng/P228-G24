import fs from 'fs';

function parseCSV(content) {
  const lines = content.trim().split('\n');
  const header = lines[0].split(',').map(c => c.replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
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

const rawRecords = fs.readFileSync('./artifacts/raw_results.jsonl', 'utf-8').trim().split('\n').map(l => JSON.parse(l));
const benchmarkRows = parseCSV(fs.readFileSync('./final_benchmark_vi.csv', 'utf-8'));
const bmMap = new Map();
benchmarkRows.forEach(b => bmMap.set(b.test_id, b));

console.log('=== FULL FORENSIC RECONCILIATION AUDIT ===');

// 1. Audit Answerable (291 cases)
let answerableVerifiedPass = 0;
let answerableVerifiedFail = 0;
benchmarkRows.filter(b => b.answerability === 'ANSWERABLE').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  if (raw && raw.pass_fail === 'PASS') answerableVerifiedPass++;
  else answerableVerifiedFail++;
});
console.log('Answerable Total:', benchmarkRows.filter(b => b.answerability === 'ANSWERABLE').length);
console.log('Answerable Pass (Claimed 223):', answerableVerifiedPass);
console.log('Answerable Fail (Claimed 68):', answerableVerifiedFail);

// 2. Audit Out-of-KB (80 cases)
let outOfKbVerifiedPass = 0;
benchmarkRows.filter(b => b.answerability === 'UNANSWERABLE' || b.answerability === 'OUT_OF_SCOPE').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  if (raw && raw.pass_fail === 'PASS') outOfKbVerifiedPass++;
});
console.log('\nOut-of-KB Total:', benchmarkRows.filter(b => b.answerability === 'UNANSWERABLE' || b.answerability === 'OUT_OF_SCOPE').length);
console.log('Out-of-KB Pass (Claimed 80):', outOfKbVerifiedPass);

// 3. Audit Ambiguous (90 cases)
let ambiguousVerifiedPass = 0;
benchmarkRows.filter(b => b.answerability === 'AMBIGUOUS').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  if (raw && raw.pass_fail === 'PASS') ambiguousVerifiedPass++;
});
console.log('\nAmbiguous Total:', benchmarkRows.filter(b => b.answerability === 'AMBIGUOUS').length);
console.log('Ambiguous Pass (Claimed 90):', ambiguousVerifiedPass);

// 4. Audit Numeric Exactness (190 cases)
let numericVerifiedPass = 0;
benchmarkRows.filter(b => b.is_numeric === 'TRUE').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  if (raw && raw.pass_fail === 'PASS') numericVerifiedPass++;
});
console.log('\nNumeric Total:', benchmarkRows.filter(b => b.is_numeric === 'TRUE').length);
console.log('Numeric Pass (Claimed 137):', numericVerifiedPass);

// 5. Audit Multi-turn (143 turns)
let multiTurnVerifiedPass = 0;
benchmarkRows.filter(b => b.is_multi_turn === 'TRUE').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  if (raw && raw.pass_fail === 'PASS') multiTurnVerifiedPass++;
});
console.log('\nMulti-turn Total Turns:', benchmarkRows.filter(b => b.is_multi_turn === 'TRUE').length);
console.log('Multi-turn Pass Turns (Claimed 113):', multiTurnVerifiedPass);

// 6. Audit Real User (101 cases)
let realUserVerifiedPass = 0;
benchmarkRows.filter(b => b.source_type === 'REAL_USER').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  if (raw && raw.pass_fail === 'PASS') realUserVerifiedPass++;
});
console.log('\nReal User Total:', benchmarkRows.filter(b => b.source_type === 'REAL_USER').length);
console.log('Real User Pass (Claimed 94):', realUserVerifiedPass);

// 7. Audit Synthetic (360 cases)
let syntheticVerifiedPass = 0;
benchmarkRows.filter(b => b.source_type === 'SYNTHETIC').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  if (raw && raw.pass_fail === 'PASS') syntheticVerifiedPass++;
});
console.log('\nSynthetic Total:', benchmarkRows.filter(b => b.source_type === 'SYNTHETIC').length);
console.log('Synthetic Pass (Claimed 299):', syntheticVerifiedPass);
