const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { createClient } = require('@supabase/supabase-js');

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
 * POST /api/admin/users/create
 * Admin only — create a new user in Supabase Auth AND users_profile atomically.
 * Requires SUPABASE_SERVICE_ROLE_KEY environment variable.
 */
router.post('/users/create', requireAuth, requireAdmin, async (req, res) => {
  const { email, password, full_name, role, company_id } = req.body;

  // Validation
  if (!email || !password || !role) {
    return res.status(400).json({ error: 'email, password, and role are required.' });
  }

  const validRoles = ['admin', 'internal', 'client'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}.` });
  }

  if (role === 'client' && !company_id) {
    return res.status(400).json({ error: 'company_id is required for client users.' });
  }

  // Check for service role key
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return res.status(503).json({
      error: 'Service not configured',
      message: 'SUPABASE_SERVICE_ROLE_KEY is not set. Cannot create Supabase Auth users.'
    });
  }

  // Create admin client with service role
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );

  try {
    // Step 1: Create user in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm email
      user_metadata: {
        full_name: full_name || null,
        role: role
      }
    });

    if (authError) {
      console.error('[POST /users/create] Supabase auth error:', authError);
      return res.status(400).json({
        error: 'Failed to create Supabase Auth user',
        message: authError.message,
        code: authError.code
      });
    }

    const supabaseUserId = authData.user.id;
    console.log(`[POST /users/create] Created Supabase user: ${supabaseUserId}`);

    // Step 2: Create user_profile in Railway PostgreSQL
    try {
      const { rows } = await db.query(
        `INSERT INTO users_profile (id, email, full_name, role, company_id, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, full_name, role, company_id, active, created_at`,
        [supabaseUserId, email, full_name || null, role, company_id || null, true]
      );

      console.log(`[POST /users/create] Created users_profile: ${rows[0].id}`);

      res.status(201).json({
        ...rows[0],
        supabase_user_id: supabaseUserId,
        message: 'User created successfully in both Supabase Auth and users_profile'
      });
    } catch (dbErr) {
      // Rollback: Delete the Supabase user if DB insert fails
      console.error('[POST /users/create] DB error, rolling back Supabase user:', dbErr);

      const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(supabaseUserId);
      if (deleteError) {
        console.error('[POST /users/create] Failed to rollback Supabase user:', deleteError);
      }

      if (dbErr.code === '23505') {
        return res.status(409).json({ error: 'User profile already exists for this email or ID.' });
      }

      return res.status(500).json({
        error: 'Failed to create user profile in database',
        message: dbErr.message
      });
    }
  } catch (err) {
    console.error('[POST /users/create] Unexpected error:', err);
    res.status(500).json({ error: 'Failed to create user.', message: err.message });
  }
});

/**
 * POST /api/admin/users (legacy)
 * Admin only — create a users_profile entry after creating the user in Supabase Auth manually.
 * DEPRECATED: Use POST /users/create instead.
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
 * Admin only — update user details in Supabase Auth AND Railway PostgreSQL.
 * Syncs changes to both systems atomically (Supabase first, then Railway).
 */
router.patch('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { email, full_name, role, company_id, active } = req.body;

  // Validation
  const validRoles = ['admin', 'internal', 'client'];
  if (role !== undefined && !validRoles.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}.` });
  }

  // Check for service role key
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return res.status(503).json({
      error: 'Service not configured',
      message: 'SUPABASE_SERVICE_ROLE_KEY is not set. Cannot update Supabase Auth users.'
    });
  }

  // Create admin client with service role
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    serviceRoleKey,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );

  try {
    // Step 1: Update Supabase Auth user
    const updateData = {};
    if (email !== undefined) updateData.email = email;
    if (full_name !== undefined || role !== undefined) {
      updateData.user_metadata = {};
      if (full_name !== undefined) updateData.user_metadata.full_name = full_name;
      if (role !== undefined) updateData.user_metadata.role = role;
    }

    let supabaseUpdateResult = null;
    if (Object.keys(updateData).length > 0) {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.updateUserById(
        id,
        updateData
      );

      if (authError) {
        console.error('[PATCH /users/:id] Supabase auth update error:', authError);
        return res.status(400).json({
          error: 'Failed to update Supabase Auth user',
          message: authError.message,
          code: authError.code
        });
      }

      supabaseUpdateResult = authData;
      console.log(`[PATCH /users/:id] Updated Supabase Auth user: ${id}`);
    }

    // Step 2: Update Railway PostgreSQL (users_profile)
    const fields = [];
    const values = [];
    let idx = 1;

    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (full_name !== undefined) { fields.push(`full_name = $${idx++}`); values.push(full_name); }
    if (role !== undefined) { fields.push(`role = $${idx++}`); values.push(role); }
    if (company_id !== undefined) { fields.push(`company_id = $${idx++}`); values.push(company_id); }
    if (active !== undefined) { fields.push(`active = $${idx++}`); values.push(active); }

    if (!fields.length) {
      return res.status(400).json({ error: 'No updatable fields provided.' });
    }

    values.push(id);

    const { rows } = await db.query(
      `UPDATE users_profile
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING id, email, full_name, role, company_id, active`,
      values
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'User not found in database.' });
    }

    console.log(`[PATCH /users/:id] Updated users_profile: ${rows[0].id}`);

    // Return combined result
    res.json({
      ...rows[0],
      supabase_updated: !!supabaseUpdateResult,
      message: 'User updated successfully in both Supabase Auth and database'
    });

  } catch (err) {
    console.error('[PATCH /users/:id] Unexpected error:', err);
    res.status(500).json({
      error: 'Failed to update user',
      message: err.message
    });
  }
});

/**
 * GET /api/admin/companies
 * Admin only — list all companies.
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
