const fs = require('fs');
const path = require('path');

const DOCS_PATH = process.env.DOCUMENTS_PATH || '/data/documents';

/**
 * Save a file buffer to the Railway Volume under /{profileId}/{filename}.
 * Creates the directory if it doesn't already exist.
 */
function saveDocument(profileId, filename, buffer) {
  // Prevent path traversal attacks
  const safeProfileId = path.basename(profileId);
  const safeFilename = path.basename(filename);

  const dir = path.join(DOCS_PATH, safeProfileId);
  fs.mkdirSync(dir, { recursive: true });

  const filepath = path.join(dir, safeFilename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * Read a file from the Railway Volume.
 * filepath is the value stored in documents.storage_path.
 * We never expose this path in API responses.
 */
function readDocument(filepath) {
  // Validate the resolved path is inside DOCS_PATH
  const resolved = path.resolve(filepath);
  const base = path.resolve(DOCS_PATH);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path traversal detected. Access denied.');
  }
  return fs.readFileSync(resolved);
}

/**
 * Delete a document file from the volume.
 */
function deleteDocument(filepath) {
  const resolved = path.resolve(filepath);
  const base = path.resolve(DOCS_PATH);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('Path traversal detected. Access denied.');
  }
  if (fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
  }
}

module.exports = { saveDocument, readDocument, deleteDocument, DOCS_PATH };
