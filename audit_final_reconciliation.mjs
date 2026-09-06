import fs from 'fs';
import path from 'path';

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

const rawRecords = fs.readFileSync('./artifacts/raw_results.jsonl', 'utf-8').trim().split('\n').map(l => JSON.parse(l));
const benchmarkRows = parseCSV(fs.readFileSync('./final_benchmark_vi.csv', 'utf-8'));
const faAuditRows = parseCSV(fs.readFileSync('./artifacts/false_abstention_audit.csv', 'utf-8'));

const bmMap = new Map();
benchmarkRows.forEach(b => bmMap.set(b.test_id, b));

const faAuditMap = new Map();
faAuditRows.forEach(fa => faAuditMap.set(fa.test_id, fa));

console.log('=== FINAL AUTHORITATIVE FORENSIC RECONCILIATION ===');

// 1. Reconcile 461 Partition
let passCount = 0;
let failVerifiedCount = 0;
let failNotVerifiedCount = 0;
let execErrorCount = 0;

rawRecords.forEach(r => {
  if (r.pass_fail === 'PASS') {
    passCount++;
  } else if (r.pass_fail === 'FAIL') {
    const fa = faAuditMap.get(r.test_id);
    if (r.failure_mode === 'GENERATION_DISTORTION' || (fa && fa.classification === 'FALSE_ABSTENTION_AFTER_SUCCESSFUL_RETRIEVAL')) {
      failVerifiedCount++;
    } else {
      failNotVerifiedCount++;
    }
  } else {
    execErrorCount++;
  }
});

console.log(`Partition 461: PASS=${passCount}, FAIL_VERIFIED=${failVerifiedCount}, FAIL_NOT_VERIFIED=${failNotVerifiedCount}, EXEC_ERROR=${execErrorCount}`);
console.log(`Sum: ${passCount + failVerifiedCount + failNotVerifiedCount + execErrorCount} / 461`);

// 2. Reconcile 68 Failures CSV
const failureReconciliationRows = [
  ['test_id', 'pass_fail', 'failure_mode', 'root_cause_status']
];

rawRecords.filter(r => r.pass_fail === 'FAIL').forEach(r => {
  const fa = faAuditMap.get(r.test_id);
  let status = 'NOT_VERIFIED';
  if (r.failure_mode === 'GENERATION_DISTORTION' || (fa && fa.classification === 'FALSE_ABSTENTION_AFTER_SUCCESSFUL_RETRIEVAL')) {
    status = 'VERIFIED';
  }
  failureReconciliationRows.push([
    r.test_id, r.pass_fail, r.failure_mode, status
  ]);
});

fs.writeFileSync('./artifacts/failure_reconciliation.csv', toCSV(failureReconciliationRows), 'utf-8');
console.log('Saved artifacts/failure_reconciliation.csv successfully!');

// 3. Reconcile Retrieval x Generation Matrix (Sum = 461)
let cellA = 0, cellB = 0, cellC = 0, cellD = 0;

rawRecords.forEach(r => {
  const bm = bmMap.get(r.test_id);
  const retSuccess = r.retrieval_evidence_sufficient === true;
  const genSuccess = r.pass_fail === 'PASS';

  if (retSuccess && genSuccess) cellA++;
  else if (retSuccess && !genSuccess) cellB++;
  else if (!retSuccess && genSuccess) cellC++;
  else if (!retSuccess && !genSuccess) cellD++;
});

console.log(`\nRetrieval x Generation Matrix (Sum = ${cellA + cellB + cellC + cellD}):`);
console.log(`Cell A (Ret Success + Gen Success): ${cellA}`);
console.log(`Cell B (Ret Success + Gen Failure): ${cellB}`);
console.log(`Cell C (Ret Failure + Gen Success/Abstain): ${cellC}`);
console.log(`Cell D (Ret Failure + Gen Failure): ${cellD}`);

// 4. Reconcile Multi-turn Conversation Level vs Turn Level
const convMap = new Map();
benchmarkRows.filter(b => b.is_multi_turn === 'TRUE').forEach(b => {
  const raw = rawRecords.find(r => r.test_id === b.test_id);
  const cId = b.conversation_id;
  if (!convMap.has(cId)) convMap.set(cId, []);
  convMap.get(cId).push(raw ? raw.pass_fail === 'PASS' : false);
});

let convLevelSuccess = 0;
let convLevelFailure = 0;
convMap.forEach((turns, cId) => {
  if (turns.every(t => t === true)) convLevelSuccess++;
  else convLevelFailure++;
});

console.log(`\nMulti-turn Scenarios Total: ${convMap.size}`);
console.log(`Conversation-Level Success: ${convLevelSuccess}`);
console.log(`Conversation-Level Failure: ${convLevelFailure}`);
