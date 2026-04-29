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
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Missing Bearer token.' });
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
    return res.status(403).json({ error: 'Forbidden', message: 'User profile not found.' });
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
