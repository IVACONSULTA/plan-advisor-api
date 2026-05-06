const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth } = require('../lib/supabase');

/**
 * GET /api/countries
 * Admin: all countries.
 * Internal/Client: only countries with at least one active profile.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    let rows;

    if (req.userRole === 'admin') {
      ({ rows } = await db.query(
        `SELECT c.id, c.code, c.name, c.created_by, c.created_at
         FROM countries c
         ORDER BY c.name ASC`
      ));
    } else {
      // Only countries that have at least one active calculation profile
      ({ rows } = await db.query(
        `SELECT DISTINCT c.id, c.code, c.name, c.created_at
         FROM countries c
         JOIN calculation_profiles cp ON cp.country_id = c.id
         WHERE cp.status = 'active'
         ORDER BY c.name ASC`
      ));
    }

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch countries.' });
  }
});

module.exports = router;
