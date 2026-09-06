import fs from 'fs';

function csvToXlsxXml(csvContent, sheetName) {
  const lines = csvContent.trim().split('\n');
  const rows = lines.map(line => {
    // Simple CSV parser handling quotes
    const cells = [];
    let insideQuote = false;
    let currentCell = '';
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && (i === 0 || line[i-1] !== '\\')) {
        insideQuote = !insideQuote;
      } else if (char === ',' && !insideQuote) {
        cells.push(currentCell.replace(/^"|"$/g, '').replace(/""/g, '"'));
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    cells.push(currentCell.replace(/^"|"$/g, '').replace(/""/g, '"'));
    return cells;
  });

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n<Worksheet ss:Name="${sheetName}">\n<Table>\n`;
  
  rows.forEach(row => {
    xml += '  <Row>\n';
    row.forEach(cell => {
      const safeCell = String(cell ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
      xml += `    <Cell><Data ss:Type="String">${safeCell}</Data></Cell>\n`;
    });
    xml += '  </Row>\n';
  });

  xml += '</Table>\n</Worksheet>\n</Workbook>';
  return xml;
}

const files = [
  { csv: 'golden_dataset_vi.csv', xlsx: 'golden_dataset_vi.xlsx', sheet: 'Golden_Dataset' },
  { csv: 'diagnostic_dataset_vi.csv', xlsx: 'diagnostic_dataset_vi.xlsx', sheet: 'Diagnostic_Dataset' },
  { csv: 'real_user_dataset_vi.csv', xlsx: 'real_user_dataset_vi.xlsx', sheet: 'Real_User_Dataset' },
  { csv: 'regression_dataset_vi.csv', xlsx: 'regression_dataset_vi.xlsx', sheet: 'Regression_Dataset' }
];

files.forEach(f => {
  if (fs.existsSync(f.csv)) {
    const csvContent = fs.readFileSync(f.csv, 'utf-8');
    const xmlContent = csvToXlsxXml(csvContent, f.sheet);
    fs.writeFileSync(f.xlsx, xmlContent, 'utf-8');
    console.log(`Generated ${f.xlsx} successfully!`);
  }
});
