import fs from 'fs';

const rawReport = JSON.parse(fs.readFileSync('./bench/rag-eval-report.json', 'utf-8'));
console.log('=== RAW LOG BENCHMARK AUDIT ===');
console.log(`Ran At: ${rawReport.ranAt}`);
console.log(`Agent Model: ${rawReport.agentModel}`);
console.log(`Total Raw Rows in rag-eval-report.json: ${rawReport.rows.length}`);

let passCount = 0;
let failCount = 0;

let recallSum = 0;
let recallCount = 0;

const handlingCounts = {};
const categoryCounts = {};
const matrix = {
  highR_highF: 0,
  highR_lowF: 0,
  lowR_highF: 0,
  lowR_lowF: 0
};

rawReport.rows.forEach(r => {
  if (r.behaviourOk) passCount++; else failCount++;
  
  if (r.handling) handlingCounts[r.handling] = (handlingCounts[r.handling] || 0) + 1;
  if (r.category) categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1;

  if (r.contextRecall !== null && r.contextRecall !== undefined) {
    recallSum += r.contextRecall;
    recallCount++;
  }

  // Faithfulness / Recall Matrix classification
  const isHighRecall = (r.contextRecall ?? 1.0) >= 0.8;
  const isHighFaith = r.handling !== 'sai' && r.handling !== 'khong_hop_ly';

  if (isHighRecall && isHighFaith) matrix.highR_highF++;
  else if (isHighRecall && !isHighFaith) matrix.highR_lowF++;
  else if (!isHighRecall && isHighFaith) matrix.lowR_highF++;
  else matrix.lowR_lowF++;
});

console.log(`PASS Count: ${passCount}`);
console.log(`FAIL Count: ${failCount}`);
console.log(`Calculated Pass Rate: ${(passCount / rawReport.rows.length * 100).toFixed(2)}%`);
console.log(`Average Context Recall (over ${recallCount} cases with recall): ${(recallSum / recallCount * 100).toFixed(2)}%`);
console.log('Handling breakdown:', handlingCounts);
console.log('Category breakdown:', categoryCounts);
console.log('Matrix breakdown:', matrix);

// Audit VI-P-02 specifically
const vip02 = rawReport.rows.find(r => r.id === 'VI-P-02');
console.log('\n=== CASE VI-P-02 RAW RECORD ===');
console.log(JSON.stringify(vip02, null, 2));

// Audit VI-P-04 specifically
const vip04 = rawReport.rows.find(r => r.id === 'VI-P-04');
console.log('\n=== CASE VI-P-04 RAW RECORD ===');
console.log(JSON.stringify(vip04, null, 2));
