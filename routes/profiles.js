const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { logAudit } = require('../lib/audit');
const { calculatorRuleGroupsCountSelect } = require('../lib/calculator-rules-count');

/**
 * POST /api/admin/profiles
 * Admin only — find or create a calculation profile in 'draft' status.
 * Returns existing profile if country+provider match found, otherwise creates new.
 * 
 * Body: 
 *   { country_id, provider_id, version, currency, ... }  (existing UUIDs)
 * OR
 *   { country_code, country_name, provider_name, provider_type, version, currency, ... }  (wizard)
 */
router.post('/profiles', requireAuth, requireAdmin, async (req, res) => {
  const { 
    country_id, 
    provider_id, 
    country_code, 
    country_name,
    provider_name,
    provider_type,
    version, 
    currency, 
    calculation_basis, 
    notes 
  } = req.body;

  if (!version || !currency) {
    return res.status(400).json({
      error: 'version and currency are required.',
    });
  }

  try {
    let resolvedCountryId = country_id;
    let resolvedProviderId = provider_id;

    // Auto-create country if code/name provided
    if (!resolvedCountryId && country_code && country_name) {
      const { rows: countryRows } = await db.query(
        `INSERT INTO countries (code, name, created_by, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [country_code.toUpperCase(), country_name.trim(), req.user.id]
      );
      resolvedCountryId = countryRows[0].id;
    }

    // Auto-create provider if name provided
    if (!resolvedProviderId && provider_name) {
      const provType = provider_type || 'PA';
      const { rows: providerRows } = await db.query(
        `INSERT INTO providers (name, type, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (name) DO UPDATE SET type = EXCLUDED.type
         RETURNING id`,
        [provider_name.trim(), provType]
      );
      resolvedProviderId = providerRows[0].id;
    }

    if (!resolvedCountryId || !resolvedProviderId) {
      return res.status(400).json({
        error: 'Must provide either (country_id, provider_id) or (country_code, country_name, provider_name).',
      });
    }

    // Always create a fresh draft profile so the wizard gets a unique ID that is not
    // confused with any existing active or archived profile for the same country+provider.
    // Previously this endpoint returned an existing profile when one was found, which caused
    // documents uploaded at step 2 to be linked to the wrong (active) profile.
    const { rows } = await db.query(
      `INSERT INTO calculation_profiles
         (country_id, provider_id, version, currency, calculation_basis, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6)
       RETURNING *`,
      [resolvedCountryId, resolvedProviderId, version, currency,
       calculation_basis || 'PA transactions', req.user.id]
    );
    res.status(201).json({ ...rows[0], reused: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create profile.' });
  }
});

/**
 * GET /api/admin/profiles/:id
 * Admin only — full profile with rules, plans, and assumptions.
 */
router.get('/profiles/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const profileResult = await db.query(
      `SELECT cp.*,
              co.code AS country_code, co.name AS country_name,
              pr.name AS provider_name
       FROM calculation_profiles cp
       JOIN countries  co ON co.id = cp.country_id
       JOIN providers  pr ON pr.id = cp.provider_id
       WHERE cp.id = $1`,
      [id]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const [rules, plans, assumptions] = await Promise.all([
      db.query(
        `SELECT * FROM transaction_rules WHERE profile_id = $1 ORDER BY created_at ASC`,
        [id]
      ),
      db.query(
        `SELECT * FROM plans WHERE profile_id = $1 ORDER BY annual_fee ASC`,
        [id]
      ),
      db.query(
        `SELECT * FROM assumptions WHERE profile_id = $1 ORDER BY created_at ASC`,
        [id]
      ),
    ]);

    res.json({
      ...profileResult.rows[0],
      rules:       rules.rows,
      plans:       plans.rows,
      assumptions: assumptions.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
});

/**
 * GET /api/admin/profiles
 * Admin only — list all profiles with country/provider info.
 */
router.get('/profiles', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cp.id, cp.version, cp.status, cp.currency, cp.active_from, cp.active_to,
              cp.created_at, cp.approved_at,
              co.code AS country_code, co.name AS country_name,
              pr.name AS provider_name, pr.type AS provider_type,
              ${calculatorRuleGroupsCountSelect()} AS rules_count,
              (SELECT COUNT(*)::int FROM plans pl
                 WHERE pl.profile_id = cp.id AND pl.status = 'approved') AS plans_count
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       ORDER BY cp.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profiles.' });
  }
});

/**
 * POST /api/admin/profiles/:id/activate
 * Admin only — activate a profile after validation.
 * Preconditions: ≥1 approved rule, ≥1 approved plan, no critical conflicts.
 */
router.post('/profiles/:id/activate', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const profileResult = await db.query(
      `SELECT * FROM calculation_profiles WHERE id = $1`,
      [id]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const profile = profileResult.rows[0];

    if (profile.status === 'active') {
      return res.status(409).json({ error: 'Profile is already active.' });
    }

    // Validation: at least one approved rule
    const { rows: approvedRules } = await db.query(
      `SELECT COUNT(*) AS count FROM transaction_rules
       WHERE profile_id = $1 AND status = 'approved'`,
      [id]
    );
    if (parseInt(approvedRules[0].count, 10) === 0) {
      return res.status(422).json({
        error: 'activation_failed',
        reason: 'Profile must have at least one approved transaction rule.',
      });
    }

    // Validation: at least one approved plan
    const { rows: approvedPlans } = await db.query(
      `SELECT COUNT(*) AS count FROM plans
       WHERE profile_id = $1 AND status = 'approved'`,
      [id]
    );
    if (parseInt(approvedPlans[0].count, 10) === 0) {
      return res.status(422).json({
        error: 'activation_failed',
        reason: 'Profile must have at least one approved plan.',
      });
    }

    // Archive any previously active profile for the same country+provider
    await db.query(
      `UPDATE calculation_profiles
       SET status = 'archived', active_to = CURRENT_DATE
       WHERE country_id = $1 AND provider_id = $2
         AND status = 'active' AND id != $3`,
      [profile.country_id, profile.provider_id, id]
    );

    // Activate this profile
    const { rows } = await db.query(
      `UPDATE calculation_profiles
       SET status = 'active', active_from = CURRENT_DATE,
           approved_by = $1, approved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.id, id]
    );

    await logAudit({
      userId:     req.user.id,
      action:     'activate_profile',
      entityType: 'calculation_profile',
      entityId:   id,
      beforeJson: { status: profile.status },
      afterJson:  { status: 'active' },
    });

    const promoteSlugRaw =
      typeof req.body?.promote_profile_slug === 'string'
        ? req.body.promote_profile_slug.trim()
        : '';

    let promoted_documents = [];
    if (promoteSlugRaw) {
      try {
        const { promoteStagingToProfile } = require('../lib/document-staging');
        promoted_documents = await promoteStagingToProfile(
          promoteSlugRaw,
          rows[0].country_id,
          rows[0].provider_id,
          id,
          req.user.id
        );
      } catch (promoteErr) {
        console.error('promoteStagingToProfile:', promoteErr);
        return res.status(500).json({
          error:
            'Profile was activated but staged documents could not be promoted to live storage. Use POST /api/admin/documents/promote-staging or fix the error.',
          detail: String(promoteErr.message || promoteErr),
          profile: rows[0],
        });
      }
    }

    res.json({ ...rows[0], promoted_documents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to activate profile.' });
  }
});

/**
 * DELETE /api/admin/profiles/:id
 * Admin only — delete a calculation profile (only if status is NOT 'active').
 * Also deletes related documents from storage.
 */
router.delete('/profiles/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: profileRows } = await db.query(
      `SELECT id, status, country_id, provider_id FROM calculation_profiles WHERE id = $1`,
      [id]
    );

    if (!profileRows.length) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const profile = profileRows[0];

    if (profile.status === 'active') {
      return res.status(400).json({
        error: 'Cannot delete active profile. Archive it first or change status.',
      });
    }

    const { rows: documents } = await db.query(
      `SELECT id, storage_path FROM documents WHERE profile_id = $1`,
      [id]
    );

    const { deleteDocument } = require('../lib/storage');
    for (const doc of documents) {
      try {
        await deleteDocument(doc.storage_path);
      } catch (delErr) {
        console.warn(`[DELETE profile] Could not delete document file ${doc.storage_path}:`, delErr);
      }
    }

    await db.query('BEGIN');
    // Delete in order respecting foreign key constraints
    await db.query('DELETE FROM scenarios WHERE profile_id = $1', [id]);
    await db.query('DELETE FROM document_analyses WHERE profile_id = $1', [id]);
    await db.query('DELETE FROM plans WHERE profile_id = $1', [id]);
    await db.query('DELETE FROM transaction_rules WHERE profile_id = $1', [id]);
    await db.query('DELETE FROM assumptions WHERE profile_id = $1', [id]);
    await db.query('DELETE FROM documents WHERE profile_id = $1', [id]);
    await db.query('DELETE FROM calculation_profiles WHERE id = $1', [id]);
    await db.query('COMMIT');

    await logAudit({
      userId:     req.user.id,
      action:     'delete_profile',
      entityType: 'calculation_profile',
      entityId:   id,
      beforeJson: profile,
      afterJson:  null,
    });

    res.json({ success: true, deleted_profile_id: id });
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('[DELETE /profiles/:id]', err);
    res.status(500).json({ error: 'Failed to delete profile.' });
  }
});

module.exports = router;
