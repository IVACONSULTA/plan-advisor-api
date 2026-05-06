const crypto = require('crypto');

const SKIP_PATHS = new Set(['/health', '/live']);

/**
 * In production, PA_PLAN_API_KEY must be set so the API is not accidentally public.
 */
function validateApiKeyConfiguredAtStartup() {
  const key = String(process.env.PA_PLAN_API_KEY || '').trim();
  if (process.env.NODE_ENV === 'production' && !key) {
    console.error(
      '✗ PA_PLAN_API_KEY is required when NODE_ENV=production. Set it in Railway Variables.',
    );
    process.exit(1);
  }
  if (!key) {
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

  const expected = String(process.env.PA_PLAN_API_KEY || '').trim();
  if (!expected) {
    return next();
  }

  const provided = String(req.get('x-api-key') || '').trim();
  if (!provided) {
    return res.status(401).json({
      error: 'Invalid or missing API key.',
      hint:
        'Missing or empty X-API-Key. Set Postman Environment variable pa_plan_api_key to the exact PA_PLAN_API_KEY from Railway (Express **pa-plan-api** service → Variables). Select that environment before Send.',
    });
  }
  if (!timingSafeEqualStrings(provided, expected)) {
    return res.status(401).json({
      error: 'Invalid or missing API key.',
      hint:
        'X-API-Key does not match PA_PLAN_API_KEY. Re-copy the key from Railway → **pa-plan-api** (not Postgres). Remove surrounding quotes or stray newlines in both Railway and Postman.',
    });
  }

  return next();
}

module.exports = {
  validateApiKeyConfiguredAtStartup,
  requireApiKey,
};
