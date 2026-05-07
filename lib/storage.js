const fs = require('fs');
const path = require('path');

const DOCS_PATH = process.env.DOCUMENTS_PATH || '/data/documents';

function shouldUseS3() {
  const d = (process.env.STORAGE_DRIVER || '').toLowerCase();
  if (d === 's3') return true;
  if (d === 'filesystem' || d === 'volume' || d === 'fs') return false;
  return Boolean(process.env.S3_BUCKET || process.env.AWS_S3_BUCKET);
}

function s3Bucket() {
  return process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || '';
}

function getS3Client() {
  // Lazy-load so filesystem-only deploys never touch AWS SDK init paths unnecessarily.
  const { S3Client } = require('@aws-sdk/client-s3');
  const region =
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    process.env.S3_REGION ||
    'us-east-1';
  const endpoint =
    process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL || undefined;
  const forcePathStyle =
    String(process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true' ||
    Boolean(endpoint); // MinIO / Railway buckets often need path-style

  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
  });
}

/**
 * Save a file buffer — Railway Volume (default) or S3-compatible bucket when configured.
 * @returns {Promise<string>} Absolute filesystem path, or `s3:${objectKey}` for object storage.
 */
async function saveDocument(profileId, filename, buffer) {
  const safeProfileId = path.basename(String(profileId));
  const safeFilename = path.basename(filename);
  const key = `${safeProfileId}/${safeFilename}`;

  if (shouldUseS3()) {
    const Bucket = s3Bucket();
    if (!Bucket) {
      throw new Error('S3_BUCKET (or AWS_S3_BUCKET) is required when using object storage.');
    }
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const client = getS3Client();
    await client.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: buffer,
      })
    );
    return `s3:${key}`;
  }

  const dir = path.join(DOCS_PATH, safeProfileId);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, safeFilename);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * Read bytes — supports filesystem paths and `s3:key` refs stored in documents.storage_path.
 * @returns {Promise<Buffer>}
 */
async function readDocument(storageRef) {
  if (typeof storageRef === 'string' && storageRef.startsWith('s3:')) {
    const objectKey = storageRef.slice(3);
    const Bucket = s3Bucket();
    if (!Bucket) throw new Error('S3 bucket not configured');
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const client = getS3Client();
    const out = await client.send(
      new GetObjectCommand({ Bucket, Key: objectKey })
    );
    const chunks = [];
    for await (const chunk of out.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const resolved = path.resolve(storageRef);
  const base = path.resolve(DOCS_PATH);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path traversal detected. Access denied.');
  }
  return fs.readFileSync(resolved);
}

/**
 * Remove stored bytes (volume path or `s3:key`).
 */
async function deleteDocument(storageRef) {
  if (typeof storageRef === 'string' && storageRef.startsWith('s3:')) {
    const objectKey = storageRef.slice(3);
    const Bucket = s3Bucket();
    if (!Bucket) throw new Error('S3 bucket not configured');
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    const client = getS3Client();
    await client.send(new DeleteObjectCommand({ Bucket, Key: objectKey }));
    return;
  }

  const resolved = path.resolve(storageRef);
  const base = path.resolve(DOCS_PATH);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('Path traversal detected. Access denied.');
  }
  if (fs.existsSync(resolved)) {
    fs.unlinkSync(resolved);
  }
}

module.exports = {
  saveDocument,
  readDocument,
  deleteDocument,
  DOCS_PATH,
  shouldUseS3,
};
