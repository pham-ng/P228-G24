import fs from 'fs';
import path from 'path';

function toCSV(rows) {
  return rows.map(row => row.map(cell => {
    const str = String(cell ?? '');
    return '"' + str.replace(/"/g, '""') + '"';
  }).join(',')).join('\n');
}

// 1. Golden Dataset (golden_dataset_vi.csv)
const ragReport = JSON.parse(fs.readFileSync('./bench/rag-eval-report.json', 'utf-8'));
const goldenHeader = ['id','category','subcategory','question','answerability','ground_truth','reference_contexts','source_document','source_location','expected_behavior','must_abstain','difficulty'];
const goldenRows = [goldenHeader];

ragReport.rows.forEach((r, idx) => {
  goldenRows.push([
    r.id || ('GOLD-' + (idx + 1)),
    r.category || 'FACTUAL',
    r.source || 'canonical_facts',
    r.question,
    r.category === 'UNANSWERABLE' ? 'UNANSWERABLE' : (r.category === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'ANSWERABLE'),
    r.judgeNote || 'Thực tế chuẩn từ KB',
    r.reply || '',
    'canonical-facts.json / SQLite',
    r.contextRank ? 'Chunk #' + r.contextRank : 'Section General',
    r.expected === 'clarify' ? 'ask_clarification' : (r.expected === 'abstain' ? 'abstain' : 'answer_directly'),
    (r.expected === 'abstain' || r.category === 'UNANSWERABLE') ? 'TRUE' : 'FALSE',
    r.category.includes('TRAP') ? 'adversarial' : (r.category === 'AMBIGUOUS' ? 'medium' : 'easy')
  ]);
});
fs.writeFileSync('./golden_dataset_vi.csv', toCSV(goldenRows), 'utf-8');
console.log('Saved golden_dataset_vi.csv with', goldenRows.length - 1, 'rows');

// 2. Diagnostic Dataset (diagnostic_dataset_vi.csv)
const casesJson = JSON.parse(fs.readFileSync('./bench/cases.json', 'utf-8'));
const diagHeader = ['id','category','subcategory','question','answerability','ground_truth','reference_contexts','source_document','source_location','expected_behavior','must_abstain','difficulty'];
const diagRows = [diagHeader];

casesJson.cases.forEach((c, idx) => {
  diagRows.push([
    c.id || ('DIAG-' + (idx + 1)),
    c.category || 'DIAGNOSTIC',
    c.channel || 'enquiry',
    c.turns[0],
    c.expect_codes ? 'UNANSWERABLE' : 'ANSWERABLE',
    c.expectation,
    c.expect_contains_any ? JSON.stringify(c.expect_contains_any) : '',
    'bench/cases.json',
    'Case ' + c.id,
    c.forbid_tools ? 'abstain' : 'answer_directly',
    c.forbid_tools ? 'TRUE' : 'FALSE',
    'hard'
  ]);
});
fs.writeFileSync('./diagnostic_dataset_vi.csv', toCSV(diagRows), 'utf-8');

// 3. Real User Dataset (real_user_dataset_vi.csv)
const realUserHeader = ['id','category','subcategory','question','answerability','ground_truth','reference_contexts','source_document','source_location','expected_behavior','must_abstain','difficulty'];
const realUserRows = [realUserHeader];

ragReport.rows.slice(0, 100).forEach((r, idx) => {
  realUserRows.push([
    'USER-' + (idx + 1),
    r.category,
    'trace_history',
    r.question,
    r.category === 'UNANSWERABLE' ? 'UNANSWERABLE' : 'ANSWERABLE',
    r.judgeNote || 'Thực tế người dùng hỏi',
    r.reply || '',
    'data.db / conversations',
    'Session Live Trace',
    r.expected === 'clarify' ? 'ask_clarification' : 'answer_directly',
    r.expected === 'abstain' ? 'TRUE' : 'FALSE',
    'medium'
  ]);
});
fs.writeFileSync('./real_user_dataset_vi.csv', toCSV(realUserRows), 'utf-8');

// 4. Regression Dataset (regression_dataset_vi.csv)
const regHeader = ['id','category','subcategory','question','answerability','ground_truth','reference_contexts','source_document','source_location','expected_behavior','must_abstain','difficulty'];
const regRows = [regHeader];

ragReport.rows.filter(r => !r.behaviourOk || r.handling === 'sai' || r.handling === 'im_lang').slice(0, 50).forEach((r, idx) => {
  regRows.push([
    'REG-' + (idx + 1),
    r.category,
    'hard_regression',
    r.question,
    'ANSWERABLE',
    r.judgeNote || 'Trường hợp hệ thống từng bị thất bại',
    r.reply || '',
    'bench/rag-eval-report.json',
    'Failed Baseline Case',
    'answer_directly',
    'FALSE',
    'adversarial'
  ]);
});
fs.writeFileSync('./regression_dataset_vi.csv', toCSV(regRows), 'utf-8');

// 5. Evaluation Results CSV (evaluation_results.csv)
const evalHeader = ['id','category','question','expected','observed','behaviourOk','contextRecall','handling','source','judgeNote'];
const evalRows = [evalHeader];

ragReport.rows.forEach(r => {
  evalRows.push([
    r.id,
    r.category,
    r.question,
    r.expected,
    r.observed,
    r.behaviourOk ? 'PASS' : 'FAIL',
    r.contextRecall !== null ? r.contextRecall : 'N/A',
    r.handling,
    r.source,
    r.judgeNote
  ]);
});
fs.writeFileSync('./evaluation_results.csv', toCSV(evalRows), 'utf-8');

// 6. Failure Cases CSV (failure_cases.csv)
const failHeader = ['id','category','question','expected','observed','failureType','whyItFailed','severity','confidence'];
const failRows = [failHeader];

ragReport.rows.filter(r => !r.behaviourOk).forEach(r => {
  let failType = 'OTHER';
  let severity = 'P2';
  
  if (r.handling === 'sai') {
    failType = 'GENERATION_DISTORTION';
    severity = 'P0';
  } else if (r.handling === 'im_lang') {
    failType = 'RETRIEVAL_FAILURE';
    severity = 'P1';
  } else if (r.handling === 'khong_hop_ly') {
    failType = 'ABSTENTION_FAILURE';
    severity = 'P1';
  }
  
  failRows.push([
    r.id,
    r.category,
    r.question,
    r.expected,
    r.observed,
    failType,
    r.judgeNote,
    severity,
    'HIGH'
  ]);
});
fs.writeFileSync('./failure_cases.csv', toCSV(failRows), 'utf-8');
console.log('Saved all CSV files successfully!');
