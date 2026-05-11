const express = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const db = require('../lib/db');
const {
  promoteStagingToProfile,
  safeStagingSlug,
} = require('../lib/document-staging');
const { runDocumentAnalysis } = require('../lib/run-document-analysis');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { checkAIQuota } = require('../lib/quota');

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many wizard analysis requests. Try again in a minute.' },
});

const router = express.Router();

/**
 * POST /api/admin/wizard/run-analysis
 * Uses existing documents for profile_id (no promotion needed - documents are already persisted).
 * Body: { profile_slug, calculation_profile_id, country_id, provider_id }
 */
router.post(
  '/wizard/run-analysis',
  requireAuth,
  requireAdmin,
  checkAIQuota,
  aiLimiter,
  async (req, res) => {
    try {
      const profile_slug = String(req.body?.profile_slug ?? '').trim();
      const calculation_profile_id = String(
        req.body?.calculation_profile_id ?? ''
      ).trim();
      const country_id = String(req.body?.country_id ?? '').trim();
      const provider_id = String(req.body?.provider_id ?? '').trim();

      if (
        !profile_slug ||
        !calculation_profile_id ||
        !country_id ||
        !provider_id
      ) {
        return res.status(400).json({
          error:
            'profile_slug, calculation_profile_id, country_id, and provider_id are required.',
        });
      }

      const { rows: cpRows } = await db.query(
        `SELECT id FROM calculation_profiles
         WHERE id = $1 AND country_id = $2 AND provider_id = $3`,
        [calculation_profile_id, country_id, provider_id]
      );
      if (!cpRows.length) {
        return res.status(400).json({
          error: 'calculation_profiles row does not match profile_id, country_id, provider_id.',
        });
      }

      // Get all documents for this profile (already persisted permanently)
      // First try by profile_id, then by storage path pattern if in draft mode
      let { rows: existingDocs } = await db.query(
        `SELECT id FROM documents WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 64`,
        [calculation_profile_id]
      );
      
      // If no documents found by profile_id, try by storage path (draft mode)
      if (!existingDocs.length) {
        const draftPattern = `draft-${safeStagingSlug(profile_slug)}%`;
        const { rows: draftDocs } = await db.query(
          `SELECT id FROM documents 
           WHERE storage_path LIKE $1 
           ORDER BY created_at DESC LIMIT 64`,
          [`%${draftPattern}%`]
        );
        existingDocs = draftDocs;
        
        // Update these documents to link them to the profile now
        if (draftDocs.length) {
          await db.query(
            `UPDATE documents 
             SET profile_id = $1, country_id = $2, provider_id = $3
             WHERE id = ANY($4::uuid[])`,
            [
              calculation_profile_id,
              country_id,
              provider_id,
              draftDocs.map(d => d.id)
            ]
          );
          console.log(`[wizard/run-analysis] Linked ${draftDocs.length} draft documents to profile ${calculation_profile_id}`);
        }
      }
      
      const document_ids = existingDocs.map((r) => r.id);

      if (!document_ids.length) {
        return res.status(400).json({
          error:
            'No documents found for this profile. Upload files at step 2 first.',
        });
      }

      console.log(`[wizard/run-analysis] Found ${document_ids.length} documents for profile ${calculation_profile_id}`);

      const outcome = await runDocumentAnalysis({
        userId: req.user.id,
        profile_id: calculation_profile_id,
        document_ids,
      });

      if (outcome.kind === 'copyright_blocked') {
        return res.status(451).json(outcome.body);
      }

      res.status(201).json({
        ...outcome.payload,
        document_ids,
        documents_analyzed: document_ids.length,
      });
    } catch (err) {
      console.error('[wizard/run-analysis] Error:', err);
      res.status(500).json({ error: String(err.message || err) });
    }
  }
);

/**
 * POST /api/admin/wizard/approve-analysis
 * Approves all proposed rules & plans for profile_id; writes JSON artifact on API disk (local ops).
 * Body: { profile_id, profile_slug? }
 */
router.post('/wizard/approve-analysis', requireAuth, requireAdmin, async (req, res) => {
  try {
    const profile_id = String(req.body?.profile_id ?? '').trim();
    const profile_slug = String(req.body?.profile_slug ?? '').trim();
    if (!profile_id) {
      return res.status(400).json({ error: 'profile_id is required.' });
    }

    const ruleUp = await db.query(
      `UPDATE transaction_rules
       SET status = 'approved', approved_by = $2, approved_at = NOW()
       WHERE profile_id = $1 AND status = 'proposed'
       RETURNING id`,
      [profile_id, req.user.id]
    );
    const planUp = await db.query(
      `UPDATE plans
       SET status = 'approved', approved_by = $2, approved_at = NOW()
       WHERE profile_id = $1 AND status = 'proposed'
       RETURNING id`,
      [profile_id, req.user.id]
    );

    const baseDir =
      process.env.WIZARD_LOCAL_ARTIFACT_DIR ||
      path.join(process.cwd(), 'data', 'wizard-artifacts');
    const slugPart =
      safeStagingSlug(profile_slug || profile_id).replace(
        /[^a-zA-Z0-9-_]/g,
        ''
      ) || 'profile';
    const dir = path.join(baseDir, slugPart);
    fs.mkdirSync(dir, { recursive: true });
    const artifactPath = path.join(dir, `approved-${Date.now()}.json`);
    fs.writeFileSync(
      artifactPath,
      JSON.stringify(
        {
          profile_id,
          profile_slug: profile_slug || null,
          approved_rule_ids: ruleUp.rows.map((r) => r.id),
          approved_plan_ids: planUp.rows.map((r) => r.id),
          approved_at: new Date().toISOString(),
          approved_by: req.user.id,
        },
        null,
        2
      ),
      'utf8'
    );

    res.json({
      ok: true,
      approved_rules: ruleUp.rows.length,
      approved_plans: planUp.rows.length,
      artifact_path: artifactPath,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
