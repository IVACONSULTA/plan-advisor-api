const path = require('path');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');

// pdf-parse@1.1.1 - traditional function export
let pdfParse;
try {
  pdfParse = require('pdf-parse');
  console.log('[document-text-extract] pdf-parse@1.1.1 loaded successfully');
} catch (err) {
  console.error('[document-text-extract] Failed to load pdf-parse:', err.message);
  pdfParse = null;
}

/**
 * Extract plain text from a buffer depending on file extension.
 */
async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    if (!pdfParse || typeof pdfParse !== 'function') {
      throw new Error('PDF extraction not available. Install pdf-parse@1.1.1 package.');
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
