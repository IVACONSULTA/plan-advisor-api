const db = require('./db');

const MONTHLY_LIMITS = {
  admin:    Infinity,
  internal: 50,
  client:   10,
};

/**
 * Middleware — checks AI usage quota before calling App 3 or App 4.
 * Admin has no limit but every call is still logged.
 * Must be used after requireAuth.
 */
async function checkAIQuota(req, res, next) {
  const role  = req.userRole;
  const limit = MONTHLY_LIMITS[role] ?? 0;

  if (limit === Infinity) return next();

  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS calls
       FROM ai_usage_logs
       WHERE user_id = $1
         AND created_at >= date_trunc('month', NOW())`,
      [req.user.id]
    );

    const used = parseInt(rows[0].calls, 10);
    if (used >= limit) {
      return res.status(429).json({
        error: 'ai_quota_exceeded',
        message: `Monthly AI usage limit reached (${limit} calls for role '${role}').`,
        limit,
        used,
      });
    }

    next();
  } catch (err) {
    console.error('Quota check error:', err);
    res.status(500).json({ error: 'Internal server error during quota check.' });
  }
}

/**
 * Log a completed AI call to ai_usage_logs.
 */
async function logAIUsage({
  userId,
  action,
  model,
  inputTokens = null,
  outputTokens = null,
  estimatedCost = null,
  documentId = null,
  scenarioId = null,
  processingId = null,
}) {
  await db.query(
    `INSERT INTO ai_usage_logs
       (user_id, action, model, input_tokens, output_tokens,
        estimated_cost, document_id, scenario_id, processing_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, action, model, inputTokens, outputTokens,
     estimatedCost, documentId, scenarioId, processingId]
  );
}

module.exports = { checkAIQuota, logAIUsage };
