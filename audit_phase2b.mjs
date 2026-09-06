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

function toCSV(rows) {
  return rows.map(row => row.map(cell => {
    const str = String(cell ?? '');
    return '"' + str.replace(/"/g, '""') + '"';
  }).join(',')).join('\n');
}

const rawResultsLines = fs.readFileSync('./artifacts/raw_results.jsonl', 'utf-8').trim().split('\n');
const rawRecords = rawResultsLines.map(l => JSON.parse(l));

console.log('=== STEP 1: BASIC COUNTS AUDIT ===');
console.log('Total Raw JSONL Records:', rawRecords.length);

const testIds = new Set(rawRecords.map(r => r.test_id));
console.log('Unique Test IDs:', testIds.size);

let passCount = 0;
let failCount = 0;
let falseAbstentionRawCount = 0;

rawRecords.forEach(r => {
  if (r.pass_fail === 'PASS') passCount++;
  else if (r.pass_fail === 'FAIL') failCount++;

  if (r.failure_mode === 'FALSE_ABSTENTION_AFTER_SUCCESSFUL_RETRIEVAL') {
    falseAbstentionRawCount++;
  }
});

console.log('PASS Count:', passCount);
console.log('FAIL Count:', failCount);
console.log('Sum (PASS + FAIL):', passCount + failCount);
console.log('Raw Log False Abstentions:', falseAbstentionRawCount);

// -----------------------------------------------------------------------------
// STEP 2: AUDIT ALL 52 FALSE ABSTENTIONS
// -----------------------------------------------------------------------------
const benchmarkRows = parseCSV(fs.readFileSync('./final_benchmark_vi.csv', 'utf-8'));
const bmMap = new Map();
benchmarkRows.forEach(b => bmMap.set(b.test_id, b));

const falseAbstentionAuditRows = [
  ['test_id', 'question', 'kb_evidence_exists', 'retrieval_attempted', 'retrieved_evidence_found', 'retrieved_evidence_sufficient', 'expected_behavior', 'actual_output', 'actual_abstention', 'classification', 'evidence_reference']
];

let verifiedFalseAbstentionCount = 0;
let notVerifiedFalseAbstentionCount = 0;

rawRecords.filter(r => r.failure_mode === 'FALSE_ABSTENTION_AFTER_SUCCESSFUL_RETRIEVAL' || r.pass_fail === 'FAIL').forEach(r => {
  const bm = bmMap.get(r.test_id);
  if (!bm) return;

  const condA = bm.kb_evidence_exists === 'TRUE';
  const condB = r.retrieval_attempted === true;
  const condC = r.retrieval_evidence_found === true;
  const condD = r.retrieval_evidence_sufficient === true;
  const condE = bm.expected_behavior === 'answer_directly';
  const condF = r.model_abstained === true || r.actual_answer.includes('ESCALATE');
  const condG = r.actual_answer.includes('ESCALATE') || r.actual_answer === '' || r.model_abstained === true;

  const isVerified = condA && condB && condC && condD && condE && condF && condG;

  let classification = 'NOT_VERIFIED';
  if (isVerified) {
    classification = 'FALSE_ABSTENTION_AFTER_SUCCESSFUL_RETRIEVAL';
    verifiedFalseAbstentionCount++;
  } else {
    notVerifiedFalseAbstentionCount++;
  }

  falseAbstentionAuditRows.push([
    r.test_id,
    r.user_message,
    condA ? 'TRUE' : 'FALSE',
    condB ? 'TRUE' : 'FALSE',
    condC ? 'TRUE' : 'FALSE',
    condD ? 'TRUE' : 'FALSE',
    bm.expected_behavior,
    r.actual_answer,
    condF ? 'TRUE' : 'FALSE',
    classification,
    bm.source_document || 'canonical-facts.json'
  ]);
});

fs.writeFileSync('./artifacts/false_abstention_audit.csv', toCSV(falseAbstentionAuditRows), 'utf-8');
console.log(`Saved artifacts/false_abstention_audit.csv successfully! Verified = ${verifiedFalseAbstentionCount}, Not Verified = ${notVerifiedFalseAbstentionCount}`);
