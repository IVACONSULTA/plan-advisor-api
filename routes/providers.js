const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');

/**
 * GET /api/providers
 * All authenticated users.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, type, created_at
       FROM providers
       ORDER BY name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch providers.' });
  }
});

/**
 * POST /api/admin/providers  (mounted under /api/admin in server.js)
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
