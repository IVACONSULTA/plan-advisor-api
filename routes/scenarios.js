const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth } = require('../lib/supabase');

/**
 * GET /api/scenarios
 * - Admin: all scenarios
 * - Internal: all scenarios created by internal users
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
                cp.version
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
                cp.version
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
                cp.version
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

/**
 * GET /api/scenarios/:id
 * Full scenario detail — owner, admin, or internal users only.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT s.*,
              cp.version, cp.currency,
              co.name AS country_name,
              pr.name AS provider_name,
              up.email AS created_by_email
       FROM scenarios s
       JOIN calculation_profiles cp ON cp.id = s.profile_id
       JOIN countries co            ON co.id = cp.country_id
       JOIN providers pr            ON pr.id = cp.provider_id
       JOIN users_profile up        ON up.id = s.created_by
       WHERE s.id = $1`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Scenario not found.' });

    const scenario = rows[0];

    // Access control
    if (req.userRole === 'client') {
      const { rows: userProfile } = await db.query(
        `SELECT company_id FROM users_profile WHERE id = $1`,
        [req.user.id]
      );
      const ownScenario    = scenario.created_by === req.user.id;
      const sameCompany    = userProfile[0]?.company_id &&
                             scenario.company_id === userProfile[0].company_id;
      if (!ownScenario && !sameCompany) {
        return res.status(403).json({ error: 'Access denied.' });
      }
    }

    res.json(scenario);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch scenario.' });
  }
});

module.exports = router;
