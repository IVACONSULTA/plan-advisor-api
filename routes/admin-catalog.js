const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');

/**
 * POST /api/admin/countries
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

/**
 * POST /api/admin/providers
 * Admin only — create a new provider/PA.
 */
router.post('/providers', requireAuth, requireAdmin, async (req, res) => {
  const { name, type } = req.body;

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required.' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO providers (name, type)
       VALUES ($1, $2)
       RETURNING *`,
      [name, type]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create provider.' });
  }
});

module.exports = router;
