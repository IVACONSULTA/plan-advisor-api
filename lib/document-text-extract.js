const path = require('path');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');

// pdf-parse can export differently depending on version
let pdfParse;
try {
  pdfParse = require('pdf-parse');
  // Some versions export as { default: fn }
  if (pdfParse && typeof pdfParse.default === 'function') {
    pdfParse = pdfParse.default;
  }
} catch (err) {
  console.warn('pdf-parse not available:', err.message);
  pdfParse = null;
}

/**
 * Extract plain text from a buffer depending on file extension.
 */
async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    if (!pdfParse || typeof pdfParse !== 'function') {
      throw new Error('PDF extraction not available. Install pdf-parse package.');
    }
    const data = await pdfParse(buffer);
    return data.text;
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const lines = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        const cells = row.values.filter(Boolean).join('\t');
        if (cells) lines.push(cells);
      });
    });
    return lines.join('\n');
  }

  return buffer.toString('utf8');
}

module.exports = { extractText };
