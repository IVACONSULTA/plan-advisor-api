const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');

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

/**
 * POST /api/admin/countries  (mounted under /api/admin in server.js)
 * Admin only — create a new country.
 */
router.post('/countries', requireAuth, requireAdmin, async (req, res) => {
  const { code, name } = req.body;

  if (!code || !name) {
    return res.status(400).json({ error: 'code and name are required.' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO countries (code, name, created_by)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [code.toUpperCase(), name, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Country code already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create country.' });
  }
});

module.exports = router;
