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

const rows = parseCSV(fs.readFileSync('./final_benchmark_vi.csv', 'utf-8'));

console.log('=== BENCHMARK QUALITY & STATS AUDIT ===');
console.log('Total Rows:', rows.length);

const ids = rows.map(r => r.test_id);
const uniqueIds = new Set(ids);
console.log('Unique Test IDs:', uniqueIds.size);
console.log('Exact Duplicates:', rows.length - uniqueIds.size);

let realUserCount = 0;
let syntheticCount = 0;

let answerableCount = 0;
let unanswerableCount = 0;
let ambiguousCount = 0;
let adversarialCount = 0;

let multiTurnTurnCount = 0;
const multiTurnConvIds = new Set();
let numericCount = 0;
let falseAbstentionCandidates = 0;

rows.forEach(r => {
  if (r.source_type === 'REAL_USER') realUserCount++;
  else syntheticCount++;

  if (r.answerability === 'ANSWERABLE') answerableCount++;
  else if (r.answerability === 'UNANSWERABLE' || r.answerability === 'OUT_OF_SCOPE') unanswerableCount++;
  else if (r.answerability === 'AMBIGUOUS') ambiguousCount++;

  if (r.is_adversarial === 'TRUE' || r.difficulty === 'adversarial') adversarialCount++;
  
  if (r.is_multi_turn === 'TRUE') {
    multiTurnTurnCount++;
    multiTurnConvIds.add(r.conversation_id);
  }

  if (r.is_numeric === 'TRUE') numericCount++;

  if (r.kb_evidence_exists === 'TRUE' && r.answerability === 'ANSWERABLE') {
    falseAbstentionCandidates++;
  }
});

console.log('Real User Count:', realUserCount);
console.log('Synthetic Count:', syntheticCount);
console.log('Real User Percentage:', (realUserCount / rows.length * 100).toFixed(2) + '%');

console.log('\n--- Category Coverage ---');
console.log('ANSWERABLE:', answerableCount, '(Target >= 150) ->', answerableCount >= 150 ? 'PASS' : 'FAIL');
console.log('UNANSWERABLE / OUT_OF_KB:', unanswerableCount, '(Target >= 50) ->', unanswerableCount >= 50 ? 'PASS' : 'FAIL');
console.log('AMBIGUOUS / INCOMPLETE:', ambiguousCount, '(Target >= 40) ->', ambiguousCount >= 40 ? 'PASS' : 'FAIL');
console.log('ADVERSARIAL / FALSE PREMISE:', adversarialCount, '(Target >= 30) ->', adversarialCount >= 30 ? 'PASS' : 'FAIL');
console.log('MULTI-TURN CONVERSATION SCENARIOS:', multiTurnConvIds.size, '(Target >= 30) ->', multiTurnConvIds.size >= 30 ? 'PASS' : 'FAIL');
console.log('MULTI-TURN TURNS:', multiTurnTurnCount);
console.log('NUMERIC GOLD TESTS:', numericCount);
console.log('FALSE ABSTENTION CANDIDATES (kb_evidence_exists=TRUE & ANSWERABLE):', falseAbstentionCandidates);

// Generate XML Spreadsheet for XLSX
function csvToXlsxXml(rows, sheetName) {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n<Worksheet ss:Name="${sheetName}">\n<Table>\n`;
  
  // Header
  xml += '  <Row>\n';
  Object.keys(rows[0]).forEach(k => {
    xml += `    <Cell><Data ss:Type="String">${k}</Data></Cell>\n`;
  });
  xml += '  </Row>\n';

  rows.forEach(r => {
    xml += '  <Row>\n';
    Object.values(r).forEach(val => {
      const safeCell = String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      xml += `    <Cell><Data ss:Type="String">${safeCell}</Data></Cell>\n`;
    });
    xml += '  </Row>\n';
  });

  xml += '</Table>\n</Worksheet>\n</Workbook>';
  return xml;
}

fs.writeFileSync('./final_benchmark_vi.xlsx', csvToXlsxXml(rows, 'Final_Benchmark_VI'), 'utf-8');
console.log('Saved final_benchmark_vi.xlsx successfully!');
