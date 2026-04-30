const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth } = require('../lib/supabase');

/**
 * GET /api/me
 * Current user profile from Railway (role, company) + UI flags.
 * Used after Supabase login to hydrate the app.
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT up.id, up.email, up.full_name, up.role, up.active, up.created_at,
              up.company_id,
              c.name AS company_name,
              c.type AS company_type
       FROM users_profile up
       LEFT JOIN companies c ON c.id = up.company_id
       WHERE up.id = $1`,
      [req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const row = rows[0];
    res.json({
      id: row.id,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      active: row.active,
      created_at: row.created_at,
      company_id: row.company_id,
      company_name: row.company_name,
      company_type: row.company_type,
      // Placeholder until company-level toggle exists in schema (guide §8)
      client_summary_enabled: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

/**
 * GET /api/user/dashboard
 * Aggregates for customer/internal home: active profiles, recent scenarios, AI usage (internal).
 */
router.get('/user/dashboard', requireAuth, async (req, res) => {
  try {
    const { rows: profiles } = await db.query(
      `SELECT cp.id AS profile_id, cp.version, cp.currency, cp.active_from,
              co.code AS country_code, co.name AS country_name,
              pr.id AS provider_id, pr.name AS provider_name, pr.type AS provider_type,
              (SELECT COUNT(*)::int FROM transaction_rules tr
                 WHERE tr.profile_id = cp.id AND tr.status = 'approved') AS rules_count,
              (SELECT COUNT(*)::int FROM plans pl
                 WHERE pl.profile_id = cp.id AND pl.status = 'approved') AS plans_count
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       WHERE cp.status = 'active'
       ORDER BY co.name, pr.name
       LIMIT 50`
    );

    let recentScenarios;
    if (req.userRole === 'admin') {
      ({ rows: recentScenarios } = await db.query(
        `SELECT s.id, s.client_name, s.created_at,
                s.ai_summary IS NOT NULL AS has_summary,
                (s.result_json->>'total_pa_transactions')::text AS total_pa_transactions,
                s.result_json->'recommended_plan'->>'plan_name' AS recommended_plan,
                (s.result_json->'recommended_plan'->>'total_annual_cost')::numeric AS total_annual_cost,
                co.name AS country_name, pr.name AS provider_name, cp.version
         FROM scenarios s
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co ON co.id = cp.country_id
         JOIN providers pr ON pr.id = cp.provider_id
         ORDER BY s.created_at DESC
         LIMIT 8`
      ));
    } else if (req.userRole === 'internal') {
      ({ rows: recentScenarios } = await db.query(
        `SELECT s.id, s.client_name, s.created_at,
                s.ai_summary IS NOT NULL AS has_summary,
                (s.result_json->>'total_pa_transactions')::text AS total_pa_transactions,
                s.result_json->'recommended_plan'->>'plan_name' AS recommended_plan,
                (s.result_json->'recommended_plan'->>'total_annual_cost')::numeric AS total_annual_cost,
                co.name AS country_name, pr.name AS provider_name, cp.version,
                up.email AS created_by_email
         FROM scenarios s
         JOIN users_profile up ON up.id = s.created_by
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co ON co.id = cp.country_id
         JOIN providers pr ON pr.id = cp.provider_id
         WHERE up.role IN ('internal', 'admin')
         ORDER BY s.created_at DESC
         LIMIT 8`
      ));
    } else {
      const { rows: up } = await db.query(
        `SELECT company_id FROM users_profile WHERE id = $1`,
        [req.user.id]
      );
      const companyId = up[0]?.company_id;
      ({ rows: recentScenarios } = await db.query(
        `SELECT s.id, s.client_name, s.created_at,
                s.ai_summary IS NOT NULL AS has_summary,
                (s.result_json->>'total_pa_transactions')::text AS total_pa_transactions,
                s.result_json->'recommended_plan'->>'plan_name' AS recommended_plan,
                (s.result_json->'recommended_plan'->>'total_annual_cost')::numeric AS total_annual_cost,
                co.name AS country_name, pr.name AS provider_name, cp.version
         FROM scenarios s
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co ON co.id = cp.country_id
         JOIN providers pr ON pr.id = cp.provider_id
         WHERE s.created_by = $1 OR (s.company_id = $2 AND $2 IS NOT NULL)
         ORDER BY s.created_at DESC
         LIMIT 8`,
        [req.user.id, companyId]
      ));
    }

    let scenariosTotal = 0;
    let withSummary = 0;
    if (req.userRole === 'admin') {
      const { rows: c } = await db.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE ai_summary IS NOT NULL)::int AS w
         FROM scenarios`
      );
      scenariosTotal = c[0]?.n ?? 0;
      withSummary = c[0]?.w ?? 0;
    } else if (req.userRole === 'internal') {
      const { rows: c } = await db.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE s.ai_summary IS NOT NULL)::int AS w
         FROM scenarios s
         JOIN users_profile up ON up.id = s.created_by
         WHERE up.role IN ('internal', 'admin')`
      );
      scenariosTotal = c[0]?.n ?? 0;
      withSummary = c[0]?.w ?? 0;
    } else {
      const { rows: up } = await db.query(
        `SELECT company_id FROM users_profile WHERE id = $1`,
        [req.user.id]
      );
      const companyId = up[0]?.company_id;
      const { rows: c } = await db.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE ai_summary IS NOT NULL)::int AS w
         FROM scenarios s
         WHERE s.created_by = $1 OR (s.company_id = $2 AND $2 IS NOT NULL)`,
        [req.user.id, companyId]
      );
      scenariosTotal = c[0]?.n ?? 0;
      withSummary = c[0]?.w ?? 0;
    }

    let aiCallsThisMonth = null;
    if (req.userRole === 'internal' || req.userRole === 'admin') {
      const { rows: ai } = await db.query(
        `SELECT COUNT(*)::int AS n
         FROM ai_usage_logs
         WHERE user_id = $1
           AND created_at >= date_trunc('month', NOW())`,
        [req.user.id]
      );
      aiCallsThisMonth = ai[0]?.n ?? 0;
    }

    res.json({
      active_profiles: profiles,
      active_profiles_count: profiles.length,
      recent_scenarios: recentScenarios,
      scenario_stats: {
        total: scenariosTotal,
        with_summary: withSummary,
      },
      ai_calls_this_month: aiCallsThisMonth,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

module.exports = router;
