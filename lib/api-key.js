const crypto = require('crypto');

const SKIP_PATHS = new Set(['/health', '/live']);

/**
 * In production, PA_PLAN_API_KEY must be set so the API is not accidentally public.
 */
function validateApiKeyConfiguredAtStartup() {
  const key = process.env.PA_PLAN_API_KEY;
  if (process.env.NODE_ENV === 'production' && (!key || !String(key).trim())) {
    console.error(
      '✗ PA_PLAN_API_KEY is required when NODE_ENV=production. Set it in Railway Variables.',
    );
    process.exit(1);
  }
  if (!key || !String(key).trim()) {
    console.warn(
      '⚠ PA_PLAN_API_KEY is not set — API key gate is disabled (ok for local dev only).',
    );
  }
}

function timingSafeEqualStrings(a, b) {
  const aa = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/**
 * Require X-API-Key when PA_PLAN_API_KEY is set. Skips /health and /live only.
 */
function requireApiKey(req, res, next) {
  const path = req.path || '';

  if (SKIP_PATHS.has(path)) {
    return next();
  }

  // CORS preflight — browsers do not send custom headers on OPTIONS.
  if (req.method === 'OPTIONS') {
    return next();
  }

  const expected = process.env.PA_PLAN_API_KEY;
  if (!expected || !String(expected).trim()) {
    return next();
  }

  const provided = req.get('x-api-key');
  if (!provided || !timingSafeEqualStrings(provided, expected)) {
    return res.status(401).json({
      error: 'Invalid or missing API key.',
      hint: 'Send header X-API-Key matching PA_PLAN_API_KEY.',
    });
  }

  return next();
}

module.exports = {
  validateApiKeyConfiguredAtStartup,
  requireApiKey,
};
