const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { logAudit } = require('../lib/audit');
const { calculatorRuleGroupsCountSelect } = require('../lib/calculator-rules-count');

/**
 * POST /api/admin/profiles
 * Admin only — create a new calculation profile in 'draft' status.
 */
router.post('/profiles', requireAuth, requireAdmin, async (req, res) => {
  const { country_id, provider_id, version, currency, calculation_basis, notes } = req.body;

  if (!country_id || !provider_id || !version || !currency) {
    return res.status(400).json({
      error: 'country_id, provider_id, version, and currency are required.',
    });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO calculation_profiles
         (country_id, provider_id, version, currency, calculation_basis, status, created_by)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6)
       RETURNING *`,
      [country_id, provider_id, version, currency,
       calculation_basis || 'PA transactions', req.user.id]
    );
    res.status(201).json(rows[0]);
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

module.exports = router;
