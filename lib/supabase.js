const { createClient } = require('@supabase/supabase-js');
const db = require('./db');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Validates the Supabase JWT and attaches req.user + req.userRole.
 * Role is always read from Railway PostgreSQL — never from the JWT claims.
 */
async function requireAuth(req, res, next) {
  const raw = req.headers.authorization || req.get('Authorization') || '';
  const match = typeof raw === 'string' ? raw.match(/^\s*Bearer\s+(\S+)\s*$/i) : null;
  const token = match ? match[1] : null;

  if (!token) {
    return res.status(401).json({
      error:     'Unauthorized',
      message:   'Missing or empty Bearer token.',
      hint:
        'Send Authorization: Bearer <supabase_access_jwt>. In Postman set Environment variable access_token and use the collection import (explicit Authorization header).',
    });
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token.' });
  }

  // Fetch role and active status from Railway PostgreSQL
  const { rows } = await db.query(
    'SELECT role, active FROM users_profile WHERE id = $1',
    [user.id]
  );

  if (!rows.length) {
    return res.status(403).json({
      error:   'Forbidden',
      message: 'User profile not found.',
      hint:
        'Create a row in PostgreSQL users_profile with id = this user’s Supabase auth user UUID (same as JWT sub). Use Supabase Dashboard → Authentication → Users to copy the user id, then INSERT or POST /api/admin/users (admin JWT required). See docs/API-USER-ENDPOINTS.md and db/seed_france_b2brouter_v1.sql bootstrap pattern.',
      supabase_user_id: user.id,
    });
  }

  if (!rows[0].active) {
    return res.status(403).json({ error: 'Forbidden', message: 'Account is deactivated.' });
  }

  req.user = user;
  req.userRole = rows[0].role;
  next();
}

/**
 * Must be used after requireAuth.
 * Allows admin, internal, and client roles.
 */
async function requireAdmin(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Forbidden', message: 'Admin role required.' });
  }
  next();
}

/**
 * Factory — returns middleware that allows only the specified roles.
 * Usage: requireRole('admin', 'internal')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.userRole)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `Required role: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
}

module.exports = { supabase, requireAuth, requireAdmin, requireRole };
