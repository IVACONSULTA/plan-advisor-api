const path = require('path');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');

// pdf-parse can export differently depending on version
let pdfParse;
try {
  const pdfModule = require('pdf-parse');
  console.log('[document-text-extract] pdf-parse module type:', typeof pdfModule);
  console.log('[document-text-extract] pdf-parse keys:', Object.keys(pdfModule || {}));
  
  // Handle different export formats
  if (typeof pdfModule === 'function') {
    pdfParse = pdfModule;
  } else if (pdfModule && typeof pdfModule.default === 'function') {
    pdfParse = pdfModule.default;
  } else {
    console.error('[document-text-extract] pdf-parse module format not recognized:', pdfModule);
    pdfParse = null;
  }
  
  console.log('[document-text-extract] pdfParse final type:', typeof pdfParse);
} catch (err) {
  console.error('[document-text-extract] Failed to require pdf-parse:', err.message);
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
