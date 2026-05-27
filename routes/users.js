const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');

/**
 * GET /api/admin/users
 * Admin only — list all users with role, company, and active status.
 */
router.get('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT up.id, up.email, up.full_name, up.role,
              up.active, up.created_at,
              c.id   AS company_id,
              c.name AS company_name,
              c.type AS company_type,
              (SELECT COUNT(*)::int FROM ai_usage_logs l
                 WHERE l.user_id = up.id
                   AND l.created_at >= date_trunc('month', NOW())) AS ai_calls_this_month
       FROM users_profile up
       LEFT JOIN companies c ON c.id = up.company_id
       ORDER BY up.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

/**
 * POST /api/admin/users
 * Admin only — create a users_profile entry after creating the user in Supabase Auth.
 */
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  const { supabase_id, email, full_name, role, company_id } = req.body;

  if (!supabase_id || !email || !role) {
    return res.status(400).json({ error: 'supabase_id, email, and role are required.' });
  }

  const validRoles = ['admin', 'internal', 'client'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}.` });
  }

  if (role === 'client' && !company_id) {
    return res.status(400).json({ error: 'company_id is required for client users.' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO users_profile (id, email, full_name, role, company_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, full_name, role, company_id, active, created_at`,
      [supabase_id, email, full_name || null, role, company_id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'User profile already exists for this Supabase ID.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to create user profile.' });
  }
});

/**
 * GET /api/admin/users/:id
 * Admin only — get a single user by ID.
 */
router.get('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `SELECT up.id, up.email, up.full_name, up.role,
              up.active, up.created_at,
              c.id   AS company_id,
              c.name AS company_name,
              c.type AS company_type,
              (SELECT COUNT(*)::int FROM ai_usage_logs l
                 WHERE l.user_id = up.id
                   AND l.created_at >= date_trunc('month', NOW())) AS ai_calls_this_month
       FROM users_profile up
       LEFT JOIN companies c ON c.id = up.company_id
       WHERE up.id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[GET /users/:id]', err);
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

/**
 * PATCH /api/admin/users/:id
 * Admin only — update role, company, or active status.
 */
router.patch('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role, company_id, active, full_name } = req.body;

  // Build dynamic SET clause
  const fields = [];
  const values = [];
  let idx = 1;

  if (role !== undefined) {
    const validRoles = ['admin', 'internal', 'client'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}.` });
    }
    fields.push(`role = $${idx++}`);
    values.push(role);
  }
  if (company_id !== undefined) { fields.push(`company_id = $${idx++}`); values.push(company_id); }
  if (active    !== undefined) { fields.push(`active = $${idx++}`);     values.push(active); }
  if (full_name !== undefined) { fields.push(`full_name = $${idx++}`);  values.push(full_name); }

  if (!fields.length) {
    return res.status(400).json({ error: 'No updatable fields provided.' });
  }

  values.push(id);

  try {
    const { rows } = await db.query(
      `UPDATE users_profile
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING id, email, full_name, role, company_id, active`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

/**
 * GET /api/admin/companies
 * Admin only — list all companies for dropdowns.
 */
router.get('/companies', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, type, created_at
       FROM companies
       ORDER BY name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /companies]', err);
    res.status(500).json({ error: 'Failed to fetch companies.' });
  }
});

module.exports = router;
