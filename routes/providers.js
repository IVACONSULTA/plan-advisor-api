const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth } = require('../lib/supabase');

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

module.exports = router;
