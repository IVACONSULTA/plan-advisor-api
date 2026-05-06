const db = require('./db');

/**
 * Append an immutable entry to audit_logs.
 * Call this after any Admin action that modifies rules, plans, or profiles.
 */
async function logAudit({ userId, action, entityType, entityId, beforeJson = null, afterJson = null }) {
  await db.query(
    `INSERT INTO audit_logs
       (user_id, action, entity_type, entity_id, before_json, after_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, entityType, entityId,
     beforeJson ? JSON.stringify(beforeJson) : null,
     afterJson  ? JSON.stringify(afterJson)  : null]
  );
}

module.exports = { logAudit };
