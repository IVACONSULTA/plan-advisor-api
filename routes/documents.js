const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const axios    = require('axios');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const ExcelJS  = require('exceljs');
const rateLimit = require('express-rate-limit');

const db              = require('../lib/db');
const { saveDocument } = require('../lib/storage');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { checkAIQuota, logAIUsage }  = require('../lib/quota');

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

/**
 * Extract plain text from a buffer depending on file extension.
 */
async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
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

  // .csv, .txt, .md — plain text
  return buffer.toString('utf8');
}

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

      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to upload document.' });
    }
  }
);

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
      // Fetch document metadata + storage paths
      const { rows: docs } = await db.query(
        `SELECT d.*, cp.country_id, cp.provider_id,
                co.name AS country_name, pr.name AS provider_name
         FROM documents d
         JOIN calculation_profiles cp ON cp.id = d.profile_id
         JOIN countries  co ON co.id = cp.country_id
         JOIN providers  pr ON pr.id = cp.provider_id
         WHERE d.id = ANY($1::uuid[]) AND d.profile_id = $2`,
        [document_ids, profile_id]
      );

      if (!docs.length) {
        return res.status(404).json({ error: 'No documents found for the given IDs.' });
      }

      // Extract text from each document
      const { readDocument } = require('../lib/storage');
      const documentsWithText = await Promise.all(
        docs.map(async (doc) => {
          const buffer = await readDocument(doc.storage_path);
          const text   = await extractText(buffer, doc.filename);
          return {
            filename:         doc.filename,
            text:             text.slice(0, parseInt(process.env.MAX_CHARS_PER_DOC || '20000', 10)),
            source_url:       null,
            declared_license: null,
          };
        })
      );

      // Fetch existing rules and plans for the profile (for context)
      const [existingRules, existingPlans] = await Promise.all([
        db.query(`SELECT * FROM transaction_rules WHERE profile_id = $1`, [profile_id]),
        db.query(`SELECT * FROM plans WHERE profile_id = $1`, [profile_id]),
      ]);

      const countryName   = docs[0].country_name;
      const providerName  = docs[0].provider_name;

      // Call DocIA agent (App 3) via internal Railway network
      let agentResponse;
      try {
        const { data } = await axios.post(
          `${process.env.DOC_AGENT_URL}/analyze`,
          {
            country:        countryName,
            provider:       providerName,
            documents:      documentsWithText,
            existing_rules: existingRules.rows,
            existing_plans: existingPlans.rows,
          },
          {
            headers: { 'X-API-Key': process.env.AGENT_API_KEY },
            timeout: 120_000, // 2 minutes
          }
        );
        agentResponse = data;
      } catch (agentErr) {
        // Pass through 451 (copyright block) from the agent
        if (agentErr.response?.status === 451) {
          // Update copyright status for blocked documents
          await db.query(
            `UPDATE documents SET copyright_status = 'blocked', copyright_reason = $1
             WHERE id = ANY($2::uuid[])`,
            [agentErr.response.data.reason, document_ids]
          );
          return res.status(451).json(agentErr.response.data);
        }
        throw agentErr;
      }

      // Persist the analysis result
      const { rows: analysis } = await db.query(
        `INSERT INTO document_analyses
           (profile_id, document_ids, analysis_json, summary, status, guardrail_audit, created_by)
         VALUES ($1, $2, $3, $4, 'completed', $5, $6)
         RETURNING id, status, created_at`,
        [
          profile_id,
          document_ids,
          JSON.stringify(agentResponse),
          agentResponse.summary || null,
          JSON.stringify(agentResponse.guardrail_audit || {}),
          req.user.id,
        ]
      );

      const analysisId = analysis[0].id;

      // Persist proposed transaction rules
      if (agentResponse.rules?.length) {
        for (const rule of agentResponse.rules) {
          await db.query(
            `INSERT INTO transaction_rules
               (profile_id, input_key, label, direction, obligation, operation_group,
                pa_transactions_per_item, reason, source_excerpt, confidence, status,
                ai_proposed_value)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'proposed',$11)
             ON CONFLICT DO NOTHING`,
            [
              profile_id,
              rule.input_key, rule.label, rule.direction, rule.obligation,
              rule.operation_group, rule.pa_transactions_per_item, rule.reason,
              rule.source_excerpt || null, rule.confidence || 'medium',
              JSON.stringify({ pa_transactions_per_item: rule.pa_transactions_per_item }),
            ]
          );
        }
      }

      // Persist proposed plans
      if (agentResponse.plans?.length) {
        for (const plan of agentResponse.plans) {
          await db.query(
            `INSERT INTO plans
               (profile_id, plan_name, included_pa_transactions, annual_fee,
                monthly_fee, extra_transaction_cost, status,
                source_excerpt, confidence)
             VALUES ($1,$2,$3,$4,$5,$6,'proposed',$7,$8)
             ON CONFLICT DO NOTHING`,
            [
              profile_id,
              plan.plan_name, plan.included_pa_transactions, plan.annual_fee,
              plan.monthly_fee || null, plan.extra_transaction_cost,
              plan.source_excerpt || null, plan.confidence || 'medium',
            ]
          );
        }
      }

      // Update copyright status for processed documents
      await db.query(
        `UPDATE documents SET copyright_status = 'clear'
         WHERE id = ANY($1::uuid[])
           AND copyright_status = 'pending'`,
        [document_ids]
      );

      // Log AI usage
      await logAIUsage({
        userId:      req.user.id,
        action:      'document_analysis',
        model:       'crewai',
        processingId: agentResponse.guardrail_audit?.processing_id || null,
      });

      res.status(201).json({
        analysis_id: analysisId,
        rules_proposed: agentResponse.rules?.length || 0,
        plans_proposed: agentResponse.plans?.length || 0,
        guardrail_audit: agentResponse.guardrail_audit,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Document analysis failed.' });
    }
  }
);

module.exports = router;
