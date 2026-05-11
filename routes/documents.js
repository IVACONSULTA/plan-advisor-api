const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const rateLimit = require('express-rate-limit');

const db              = require('../lib/db');
const { saveDocument } = require('../lib/storage');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { checkAIQuota }  = require('../lib/quota');
const { runDocumentAnalysis } = require('../lib/run-document-analysis');
const {
  safeStagingSlug,
  stagingFolderKey,
  promoteStagingToProfile,
} = require('../lib/document-staging');

/** Set PA_UPLOAD_DEBUG=1 on Railway to trace uploads (no secrets logged). */
function paUploadApiDebug(...args) {
  const v = process.env.PA_UPLOAD_DEBUG;
  if (v !== '1' && String(v).toLowerCase() !== 'true') return;
  console.log('[PA upload API]', ...args);
}

// Multer — memory storage; we write to the Volume ourselves
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`File type not allowed: ${ext}`));
  },
});

/** Multer passes synchronous errors via callback — normalize for Express */
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      return res.status(400).json({
        error: typeof err.message === 'string' ? err.message : 'Upload rejected.',
      });
    }
    next();
  });
}

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many AI requests. Please wait a minute.' },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_DOC_TYPES = [
  'provider_pricing',
  'transaction_guide',
  'country_legal',
  'contract',
  'commercial_confirmation',
  'other',
];

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/documents/upload
 * Admin only — upload a document to the Railway Volume and record metadata.
 */
router.post(
  '/documents/upload',
  requireAuth,
  requireAdmin,
  uploadSingle,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const { country_id, provider_id, profile_id, document_type, description } = req.body;

    if (!country_id || !provider_id || !profile_id || !document_type) {
      return res.status(400).json({
        error: 'country_id, provider_id, profile_id, and document_type are required.',
      });
    }

    if (!VALID_DOC_TYPES.includes(document_type)) {
      return res.status(400).json({
        error: `document_type must be one of: ${VALID_DOC_TYPES.join(', ')}.`,
      });
    }

    try {
      const { rows: profRows } = await db.query(
        `SELECT id FROM calculation_profiles
         WHERE id = $1 AND country_id = $2 AND provider_id = $3`,
        [profile_id, country_id, provider_id]
      );
      if (!profRows.length) {
        return res.status(400).json({
          error:
            'No calculation_profiles row matches profile_id, country_id, and provider_id.',
        });
      }

      // Folder / object key prefix — ties stored bytes to this profile in bucket or volume
      const folderKey = profile_id;
      const storagePath = await saveDocument(folderKey, req.file.originalname, req.file.buffer);

      const { rows } = await db.query(
        `INSERT INTO documents
           (country_id, provider_id, profile_id, filename, storage_path,
            document_type, description, copyright_status, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
         RETURNING id, filename, document_type, copyright_status, created_at`,
        [
          country_id,
          provider_id,
          profile_id,
          req.file.originalname,
          storagePath,
          document_type,
          description || null,
          req.user.id,
        ]
      );

      paUploadApiDebug('stored document row', { id: rows[0]?.id, filename: rows[0]?.filename });
      res.status(201).json(rows[0]);
    } catch (err) {
      paUploadApiDebug('upload handler threw', err?.message || err);
      console.error(err);
      res.status(500).json({ error: 'Failed to upload document.' });
    }
  }
);

/**
 * POST /api/admin/documents/upload-staging
 * Wizard step 2 — now persists documents directly (no staging).
 * Creates documents records immediately with copyright_status='pending'.
 * 
 * Body: profile_slug, country_id, provider_id, profile_id, document_type, description
 * File: multipart/form-data 'file'
 */
router.post(
  '/documents/upload-staging',
  requireAuth,
  requireAdmin,
  uploadSingle,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const profile_slug_raw = String(req.body.profile_slug ?? '').trim();
    const country_id = String(req.body.country_id ?? '').trim();
    const provider_id = String(req.body.provider_id ?? '').trim();
    const profile_id = String(req.body.profile_id ?? '').trim();
    const document_type = String(req.body.document_type ?? '').trim();
    const descriptionRaw = req.body.description;
    const description =
      typeof descriptionRaw === 'string' && descriptionRaw.trim() ? descriptionRaw.trim() : null;

    if (!profile_slug_raw) {
      return res.status(400).json({ error: 'profile_slug is required.' });
    }

    if (!country_id || !provider_id || !profile_id) {
      console.log('[upload-staging] Missing IDs - will create document without full validation (wizard draft mode)');
      // For wizard drafts, we might not have IDs yet - that's OK, we'll link them later
    }

    if (!document_type || !VALID_DOC_TYPES.includes(document_type)) {
      return res.status(400).json({
        error: `document_type must be one of: ${VALID_DOC_TYPES.join(', ')}.`,
      });
    }

    try {
      // If we have profile_id, verify it exists
      if (profile_id) {
        const { rows: profRows } = await db.query(
          `SELECT id FROM calculation_profiles WHERE id = $1`,
          [profile_id]
        );
        if (!profRows.length) {
          return res.status(404).json({ error: 'calculation_profiles row not found.' });
        }
      }

      // Save directly to permanent storage (not staging)
      // Use profile_id if available, otherwise use profile_slug as folder name
      const folderKey = profile_id || `draft-${safeStagingSlug(profile_slug_raw)}`;
      const uniquePrefix = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
      const uniqueFilename = `${uniquePrefix}_${req.file.originalname}`;
      const storagePath = await saveDocument(folderKey, uniqueFilename, req.file.buffer);

      console.log(`[upload-staging] Saved to permanent storage: ${storagePath}`);

      // Create documents record immediately (not document_staging)
      const { rows } = await db.query(
        `INSERT INTO documents
           (country_id, provider_id, profile_id, filename, storage_path,
            document_type, description, copyright_status, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
         RETURNING id, filename, document_type, copyright_status, created_at`,
        [
          country_id || null,
          provider_id || null,
          profile_id || null,
          uniqueFilename,
          storagePath,
          document_type,
          description,
          req.user.id
        ]
      );

      console.log(`[upload-staging] Created documents record: ${rows[0].id}`);
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error('[upload-staging] Error:', err);
      res.status(500).json({ error: 'Failed to upload document.' });
    }
  }
);

/**
 * GET /api/admin/documents/staging?profile_slug=&profile_id=
 * Wizard step 2 — list uploaded documents for a profile (reads from documents table now)
 */
router.get('/documents/staging', requireAuth, requireAdmin, async (req, res) => {
  const profile_slug_raw = String(req.query.profile_slug ?? '').trim();
  const profile_id = String(req.query.profile_id ?? '').trim();
  
  if (!profile_slug_raw && !profile_id) {
    return res.status(400).json({ error: 'profile_slug or profile_id query param required.' });
  }

  try {
    let rows;
    
    if (profile_id) {
      // Prefer profile_id if available
      const result = await db.query(
        `SELECT id, filename, document_type, description, copyright_status, created_at
         FROM documents
         WHERE profile_id = $1
         ORDER BY created_at DESC`,
        [profile_id]
      );
      rows = result.rows;
    } else {
      // Fallback to profile_slug for drafts (look for documents with null profile_id and matching storage_path pattern)
      const profile_slug = safeStagingSlug(profile_slug_raw);
      const result = await db.query(
        `SELECT id, filename, document_type, description, copyright_status, created_at
         FROM documents
         WHERE storage_path LIKE $1
         ORDER BY created_at DESC`,
        [`%draft-${profile_slug}%`]
      );
      rows = result.rows;
    }
    
    res.json(rows);
  } catch (err) {
    console.error('[staging list] Error:', err);
    res.status(500).json({ error: 'Failed to list documents.' });
  }
});

/**
 * POST /api/admin/documents/promote-staging
 * Body: { profile_slug, country_id, provider_id, profile_id }
 */
router.post('/documents/promote-staging', requireAuth, requireAdmin, async (req, res) => {
  const {
    profile_slug,
    country_id,
    provider_id,
    profile_id,
  } = req.body || {};

  if (!profile_slug || !country_id || !provider_id || !profile_id) {
    return res.status(400).json({
      error: 'profile_slug, country_id, provider_id, and profile_id are required.',
    });
  }

  try {
    const promoted = await promoteStagingToProfile(
      String(profile_slug),
      String(country_id),
      String(provider_id),
      String(profile_id),
      req.user.id
    );
    res.json({ promoted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/**
 * GET /api/admin/documents?profile_id=&country_id=
 * Admin only — list documents for a profile or country.
 */
router.get('/documents', requireAuth, requireAdmin, async (req, res) => {
  const { profile_id, country_id } = req.query;

  if (!profile_id && !country_id) {
    return res.status(400).json({ error: 'profile_id or country_id query param required.' });
  }

  try {
    const condition = profile_id
      ? 'profile_id = $1'
      : 'country_id = $1';
    const value = profile_id || country_id;

    const { rows } = await db.query(
      // storage_path is intentionally excluded from the response
      `SELECT id, filename, document_type, description,
              copyright_status, copyright_reason, uploaded_by, created_at
       FROM documents
       WHERE ${condition}
       ORDER BY created_at DESC`,
      [value]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch documents.' });
  }
});

/**
 * POST /api/admin/documents/analyze
 * Admin only — extract text, run copyright guardrail, then call the DocIA agent.
 */
router.post(
  '/documents/analyze',
  requireAuth,
  requireAdmin,
  checkAIQuota,
  aiLimiter,
  async (req, res) => {
    const { profile_id, document_ids } = req.body;

    if (!profile_id || !Array.isArray(document_ids) || !document_ids.length) {
      return res.status(400).json({
        error: 'profile_id and document_ids[] are required.',
      });
    }

    try {
      const outcome = await runDocumentAnalysis({
        userId: req.user.id,
        profile_id,
        document_ids,
      });

      if (outcome.kind === 'copyright_blocked') {
        return res.status(451).json(outcome.body);
      }

      res.status(201).json(outcome.payload);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Document analysis failed.' });
    }
  }
);

module.exports = router;
