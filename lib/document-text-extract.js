const path = require('path');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');

// pdf-parse@2.4.5 - trying to load correctly
let pdfParse;
try {
  // First, try the standard require
  pdfParse = require('pdf-parse');
  
  console.log('[document-text-extract] pdf-parse loaded, type:', typeof pdfParse);
  
  // Log the structure to debug
  if (typeof pdfParse === 'object' && pdfParse !== null) {
    console.log('[document-text-extract] pdf-parse is object with keys:', Object.keys(pdfParse).slice(0, 15).join(', '));
    
    // Try different access patterns
    if (typeof pdfParse.default === 'function') {
      console.log('[document-text-extract] Found pdfParse.default function');
      pdfParse = pdfParse.default;
    } else if (typeof pdfParse.PDFParse === 'function') {
      console.log('[document-text-extract] Found pdfParse.PDFParse function');
      pdfParse = pdfParse.PDFParse;
    } else {
      // Module itself might be callable
      console.log('[document-text-extract] Trying module as-is (might be callable despite typeof=object)');
      // Keep pdfParse as-is and test it
    }
  }
  
  if (typeof pdfParse !== 'function' && typeof pdfParse !== 'object') {
    throw new Error(`Unexpected pdf-parse type: ${typeof pdfParse}`);
  }
  
  console.log('[document-text-extract] ✓ pdf-parse ready (final type: ' + typeof pdfParse + ')');
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
    if (!pdfParse) {
      throw new Error('PDF extraction not available. Install pdf-parse package.');
    }
    
    try {
      // pdf-parse might be object but still callable, or might be a function
      const data = await pdfParse(buffer);
      return data.text;
    } catch (parseErr) {
      console.error('[document-text-extract] PDF parse failed:', parseErr.message);
      throw new Error(`PDF extraction failed: ${parseErr.message}`);
    }
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
