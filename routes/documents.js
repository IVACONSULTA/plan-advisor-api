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
 * Wizard step 2 — store bytes without calculation_profiles linkage (promoted on activate).
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
    const document_type = String(req.body.document_type ?? '').trim();
    const descriptionRaw = req.body.description;
    const description =
      typeof descriptionRaw === 'string' && descriptionRaw.trim() ? descriptionRaw.trim() : null;

    if (!profile_slug_raw) {
      return res.status(400).json({ error: 'profile_slug is required.' });
    }

    if (!document_type || !VALID_DOC_TYPES.includes(document_type)) {
      return res.status(400).json({
        error: `document_type must be one of: ${VALID_DOC_TYPES.join(', ')}.`,
      });
    }

    const profile_slug = safeStagingSlug(profile_slug_raw);

    try {
      const folderKey = stagingFolderKey(profile_slug_raw);
      const storagePath = await saveDocument(folderKey, req.file.originalname, req.file.buffer);
      const filenameStored = path.basename(req.file.originalname);

      const { rows } = await db.query(
        `INSERT INTO document_staging
           (profile_slug, filename, storage_path, document_type, description, copyright_status, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id, filename, document_type, copyright_status, created_at`,
        [profile_slug, filenameStored, storagePath, document_type, description, req.user.id]
      );

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to upload staged document.' });
    }
  }
);

/**
 * GET /api/admin/documents/staging?profile_slug=
 */
router.get('/documents/staging', requireAuth, requireAdmin, async (req, res) => {
  const profile_slug_raw = String(req.query.profile_slug ?? '').trim();
  if (!profile_slug_raw) {
    return res.status(400).json({ error: 'profile_slug query param required.' });
  }
  const profile_slug = safeStagingSlug(profile_slug_raw);

  try {
    const { rows } = await db.query(
      `SELECT id, filename, document_type, description, copyright_status, created_at
       FROM document_staging
       WHERE profile_slug = $1
       ORDER BY created_at DESC`,
      [profile_slug]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list staged documents.' });
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
