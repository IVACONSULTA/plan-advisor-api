const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth } = require('../lib/supabase');

/**
 * Load scenario with profile joins; enforce same access rules as detail GET.
 * @returns {Promise<{ fail: false, scenario: object }|{ fail: true, status: number, body: object }>}
 */
async function fetchScenarioForUser(req, id) {
  const { rows } = await db.query(
    `SELECT s.*,
            cp.version, cp.currency,
            co.name AS country_name,
            pr.name AS provider_name,
            up.email AS created_by_email,
            up.role AS created_by_role
     FROM scenarios s
     JOIN calculation_profiles cp ON cp.id = s.profile_id
     JOIN countries co            ON co.id = cp.country_id
     JOIN providers pr            ON pr.id = cp.provider_id
     JOIN users_profile up        ON up.id = s.created_by
     WHERE s.id = $1`,
    [id],
  );

  if (!rows.length) {
    return { fail: true, status: 404, body: { error: 'Scenario not found.' } };
  }

  const scenario = rows[0];

  if (req.userRole === 'internal') {
    if (!['admin', 'internal'].includes(scenario.created_by_role)) {
      return { fail: true, status: 403, body: { error: 'Access denied.' } };
    }
  }

  if (req.userRole === 'client') {
    const { rows: userProfile } = await db.query(
      `SELECT company_id FROM users_profile WHERE id = $1`,
      [req.user.id],
    );
    const ownScenario    = scenario.created_by === req.user.id;
    const sameCompany    = userProfile[0]?.company_id &&
                           scenario.company_id === userProfile[0].company_id;
    if (!ownScenario && !sameCompany) {
      return { fail: true, status: 403, body: { error: 'Access denied.' } };
    }
  }

  return { fail: false, scenario };
}

/**
 * GET /api/scenarios
 * - Admin: all scenarios
 * - Internal: scenarios whose creator role is admin or internal
 * - Client: only own scenarios (filtered by company)
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    let rows;

    if (req.userRole === 'admin') {
      ({ rows } = await db.query(
        `SELECT s.id, s.client_name, s.profile_id, s.created_at,
                s.ai_summary IS NOT NULL AS has_summary,
                up.email AS created_by_email,
                co.name  AS country_name,
                pr.name  AS provider_name,
                cp.version,
                (s.result_json->>'total_pa_transactions')::numeric AS total_pa_transactions,
                s.result_json->'recommended_plan'->>'plan_name' AS recommended_plan_name,
                (s.result_json->'recommended_plan'->>'total_annual_cost')::numeric
                  AS recommended_total_annual_cost
         FROM scenarios s
         JOIN users_profile up       ON up.id = s.created_by
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co           ON co.id = cp.country_id
         JOIN providers pr           ON pr.id = cp.provider_id
         ORDER BY s.created_at DESC
         LIMIT 200`
      ));
    } else if (req.userRole === 'internal') {
      ({ rows } = await db.query(
        `SELECT s.id, s.client_name, s.profile_id, s.created_at,
                s.ai_summary IS NOT NULL AS has_summary,
                up.email AS created_by_email,
                co.name  AS country_name,
                pr.name  AS provider_name,
                cp.version,
                (s.result_json->>'total_pa_transactions')::numeric AS total_pa_transactions,
                s.result_json->'recommended_plan'->>'plan_name' AS recommended_plan_name,
                (s.result_json->'recommended_plan'->>'total_annual_cost')::numeric
                  AS recommended_total_annual_cost
         FROM scenarios s
         JOIN users_profile up       ON up.id = s.created_by
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co           ON co.id = cp.country_id
         JOIN providers pr           ON pr.id = cp.provider_id
         WHERE up.role IN ('internal', 'admin')
         ORDER BY s.created_at DESC
         LIMIT 200`
      ));
    } else {
      // client — only own company's scenarios
      const { rows: profile } = await db.query(
        `SELECT company_id FROM users_profile WHERE id = $1`,
        [req.user.id]
      );
      const companyId = profile[0]?.company_id;

      ({ rows } = await db.query(
        `SELECT s.id, s.client_name, s.profile_id, s.created_at,
                s.ai_summary IS NOT NULL AS has_summary,
                co.name AS country_name,
                pr.name AS provider_name,
                cp.version,
                (s.result_json->>'total_pa_transactions')::numeric AS total_pa_transactions,
                s.result_json->'recommended_plan'->>'plan_name' AS recommended_plan_name,
                (s.result_json->'recommended_plan'->>'total_annual_cost')::numeric
                  AS recommended_total_annual_cost
         FROM scenarios s
         JOIN calculation_profiles cp ON cp.id = s.profile_id
         JOIN countries co           ON co.id = cp.country_id
         JOIN providers pr           ON pr.id = cp.provider_id
         WHERE s.created_by = $1
            OR (s.company_id = $2 AND $2 IS NOT NULL)
         ORDER BY s.created_at DESC
         LIMIT 100`,
        [req.user.id, companyId]
      ));
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scenarios.' });
  }
});

// Must be registered before GET /:id so "export" is not captured as :id
router.get('/:id/export', requireAuth, async (req, res) => {
  const { id } = req.params;
  const format = String(req.query.format || 'json').toLowerCase();

  const r = await fetchScenarioForUser(req, id);
  if (r.fail) return res.status(r.status).json(r.body);

  if (format !== 'json') {
    return res.status(400).json({
      error: 'Unsupported format.',
      message: 'Use ?format=json. PDF export is not implemented on the API.',
    });
  }

  const scenario = r.scenario;
  const { created_by_role: _omit, ...scenarioSafe } = scenario;

  const exportPayload = {
    exported_at: new Date().toISOString(),
    format: 'plan_advisor_scenario_v1',
    scenario: scenarioSafe,
  };

  const rawName = (scenario.client_name || 'scenario')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-') || 'scenario';
  const nameBase = rawName.slice(0, 48);
  const filename = `${nameBase}-${String(id).slice(0, 8)}.json`;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`${JSON.stringify(exportPayload, null, 2)}\n`);
});

router.delete('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  const r = await fetchScenarioForUser(req, id);
  if (r.fail) return res.status(r.status).json(r.body);

  try {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ai_usage_logs WHERE scenario_id = $1`, [id]);
      const del = await client.query(`DELETE FROM scenarios WHERE id = $1 RETURNING id`, [id]);
      await client.query('COMMIT');
      if (!del.rows.length) {
        return res.status(404).json({ error: 'Scenario not found.' });
      }
      return res.status(204).send();
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete scenario.' });
  }
});

/**
 * GET /api/scenarios/:id
 * Full scenario detail — admin (all); internal (creator must be admin/internal); client (owner or same company).
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const r = await fetchScenarioForUser(req, id);
    if (r.fail) return res.status(r.status).json(r.body);

    const { created_by_role: _omit, ...rest } = r.scenario;
    res.json(rest);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scenario.' });
  }
});

module.exports = router;
