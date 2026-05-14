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
 * Body: { profile_slug, calculation_profile_id, country_id, provider_id, message }
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
      // Optional custom message for the document analysis agent
      const message = String(req.body?.message ?? '').trim() ||
        process.env.DOCUMENT_ANALYSIS_MESSAGE ||
        '';

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
      if (message) {
        console.log(`[wizard/run-analysis] Using custom analysis message: ${message.slice(0, 100)}...`);
      }

      // ──────────────────────────────────────────────────────────────────
      // Async flow: create a `running` analysis row up front, kick off the
      // agent call in the background, and return 202 immediately so the
      // BFF/Netlify function does not time out on long agent calls.
      // Clients poll GET /wizard/analysis-status?analysis_id=… for completion.
      // ──────────────────────────────────────────────────────────────────
      const { rows: createdRows } = await db.query(
        `INSERT INTO document_analyses
           (profile_id, document_ids, analysis_json, status, guardrail_audit, created_by)
         VALUES ($1, $2, '{}'::jsonb, 'running', '{}'::jsonb, $3)
         RETURNING id`,
        [calculation_profile_id, document_ids, req.user.id]
      );
      const analysisId = createdRows[0].id;

      // Fire-and-forget — never await. Any error is captured on the row.
      (async () => {
        try {
          const outcome = await runDocumentAnalysis({
            userId: req.user.id,
            profile_id: calculation_profile_id,
            document_ids,
            message,
            existingAnalysisId: analysisId,
          });

          if (outcome.kind === 'copyright_blocked') {
            await db.query(
              `UPDATE document_analyses
                 SET status = 'failed',
                     summary = $2
               WHERE id = $1`,
              [analysisId, `copyright_blocked: ${JSON.stringify(outcome.body).slice(0, 800)}`]
            );
            console.warn(`[wizard/run-analysis] Analysis ${analysisId} blocked by copyright.`);
            return;
          }

          console.log(`[wizard/run-analysis] Analysis ${analysisId} completed successfully.`);
        } catch (bgErr) {
          console.error(`[wizard/run-analysis] Analysis ${analysisId} failed:`, bgErr);
          try {
            await db.query(
              `UPDATE document_analyses
                 SET status = 'failed',
                     summary = $2
               WHERE id = $1`,
              [analysisId, String(bgErr.message || bgErr).slice(0, 1000)]
            );
          } catch (dbErr) {
            console.error(`[wizard/run-analysis] Could not mark analysis ${analysisId} failed:`, dbErr);
          }
        }
      })();

      res.status(202).json({
        analysis_id: analysisId,
        status: 'running',
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
 * GET /api/admin/wizard/analysis-status?analysis_id=…
 * Returns current status of a document analysis kicked off via POST /wizard/run-analysis.
 *
 * Response:
 *   { analysis_id, status: 'running'|'completed'|'failed',
 *     error_message: string|null,
 *     rules_proposed: number, plans_proposed: number,
 *     created_at: ISO timestamp }
 */
router.get('/wizard/analysis-status', requireAuth, requireAdmin, async (req, res) => {
  const analysis_id = String(req.query?.analysis_id ?? '').trim();
  if (!analysis_id) {
    return res.status(400).json({ error: 'analysis_id query param is required.' });
  }

  try {
    const { rows } = await db.query(
      `SELECT da.id, da.profile_id, da.status, da.summary, da.created_at,
              (SELECT COUNT(*)::int FROM transaction_rules
                WHERE profile_id = da.profile_id) AS rules_count,
              (SELECT COUNT(*)::int FROM plans
                WHERE profile_id = da.profile_id) AS plans_count
         FROM document_analyses da
        WHERE da.id = $1`,
      [analysis_id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Analysis not found.' });
    }

    const r = rows[0];
    res.json({
      analysis_id: r.id,
      profile_id: r.profile_id,
      status: r.status,
      error_message: r.status === 'failed' ? r.summary : null,
      rules_proposed: r.rules_count || 0,
      plans_proposed: r.plans_count || 0,
      created_at: r.created_at,
    });
  } catch (err) {
    console.error('[wizard/analysis-status] Error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/**
 * POST /api/admin/wizard/approve-analysis
 * Approves all proposed rules & plans for profile_id, then activates the
 * calculation_profiles row: status → 'active', approved_by + approved_at + active_from
 * are all set to the current user / current timestamp.
 * Body: { profile_id, profile_slug? }
 */
router.post('/wizard/approve-analysis', requireAuth, requireAdmin, async (req, res) => {
  try {
    const profile_id = String(req.body?.profile_id ?? '').trim();
    const profile_slug = String(req.body?.profile_slug ?? '').trim();
    if (!profile_id) {
      return res.status(400).json({ error: 'profile_id is required.' });
    }

    // 1. Verify profile exists.
    const { rows: profileRows } = await db.query(
      `SELECT id, status FROM calculation_profiles WHERE id = $1`,
      [profile_id]
    );
    if (!profileRows.length) {
      return res.status(404).json({ error: 'Profile not found.' });
    }
    console.log(`[wizard/approve-analysis] Approving profile ${profile_id} (current status: ${profileRows[0].status})`);

    // 2. Approve all proposed transaction rules for this profile.
    const ruleUp = await db.query(
      `UPDATE transaction_rules
       SET status = 'approved', approved_by = $2, approved_at = NOW()
       WHERE profile_id = $1 AND status = 'proposed'
       RETURNING id`,
      [profile_id, req.user.id]
    );
    console.log(`[wizard/approve-analysis] Approved ${ruleUp.rows.length} rule(s)`);

    // 3. Approve all proposed plans for this profile.
    const planUp = await db.query(
      `UPDATE plans
       SET status = 'approved', approved_by = $2, approved_at = NOW()
       WHERE profile_id = $1 AND status = 'proposed'
       RETURNING id`,
      [profile_id, req.user.id]
    );
    console.log(`[wizard/approve-analysis] Approved ${planUp.rows.length} plan(s)`);

    // 4. Activate the calculation profile.
    const { rows: activatedProfile } = await db.query(
      `UPDATE calculation_profiles
         SET status      = 'active',
             approved_by = $2,
             approved_at = NOW(),
             active_from = CURRENT_DATE
       WHERE id = $1
       RETURNING id, status, approved_by, approved_at, active_from`,
      [profile_id, req.user.id]
    );
    console.log(`[wizard/approve-analysis] Profile ${profile_id} activated:`, activatedProfile[0]);

    // 5. Write local artifact (best-effort — failure does not abort the response).
    let artifactPath = null;
    try {
      const baseDir =
        process.env.WIZARD_LOCAL_ARTIFACT_DIR ||
        path.join(process.cwd(), 'data', 'wizard-artifacts');
      const slugPart =
        safeStagingSlug(profile_slug || profile_id).replace(/[^a-zA-Z0-9-_]/g, '') || 'profile';
      const dir = path.join(baseDir, slugPart);
      fs.mkdirSync(dir, { recursive: true });
      artifactPath = path.join(dir, `approved-${Date.now()}.json`);
      fs.writeFileSync(
        artifactPath,
        JSON.stringify(
          {
            profile_id,
            profile_slug: profile_slug || null,
            approved_rule_ids: ruleUp.rows.map((r) => r.id),
            approved_plan_ids: planUp.rows.map((r) => r.id),
            approved_at: activatedProfile[0].approved_at,
            active_from: activatedProfile[0].active_from,
            approved_by: req.user.id,
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (artifactErr) {
      console.warn('[wizard/approve-analysis] Could not write local artifact (non-fatal):', artifactErr.message);
    }

    res.json({
      ok: true,
      approved_rules: ruleUp.rows.length,
      approved_plans: planUp.rows.length,
      profile_status: activatedProfile[0].status,
      active_from: activatedProfile[0].active_from,
      approved_at: activatedProfile[0].approved_at,
      artifact_path: artifactPath,
    });
  } catch (err) {
    console.error('[wizard/approve-analysis] Error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
