const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { logAudit } = require('../lib/audit');

/**
 * GET /api/admin/transaction-rules?profile_id=<uuid>
 * Admin only — list all transaction rules for a profile, ordered by created_at.
 */
router.get('/transaction-rules', requireAuth, requireAdmin, async (req, res) => {
  const profile_id = String(req.query?.profile_id ?? '').trim();
  if (!profile_id) {
    return res.status(400).json({ error: 'profile_id query param is required.' });
  }
  try {
    const { rows } = await db.query(
      `SELECT id, profile_id, input_key, label, direction, obligation, operation_group,
              pa_transactions_per_item, reason, source_document_id, source_excerpt,
              confidence, status, manually_edited, approved_by, approved_at,
              index_ui, created_at
         FROM transaction_rules
        WHERE profile_id = $1
        ORDER BY index_ui NULLS LAST, created_at ASC`,
      [profile_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /transaction-rules]', err);
    res.status(500).json({ error: 'Failed to fetch transaction rules.' });
  }
});

/**
 * PATCH /api/admin/rules/:id
 * Admin only — edit a proposed or pending rule.
 */
router.patch('/rules/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    label, direction, obligation, operation_group,
    pa_transactions_per_item, reason, source_excerpt, confidence,
  } = req.body;

  try {
    const { rows: current } = await db.query(
      `SELECT * FROM transaction_rules WHERE id = $1`,
      [id]
    );
    if (!current.length) return res.status(404).json({ error: 'Rule not found.' });

    const before = current[0];

    const { rows } = await db.query(
      `UPDATE transaction_rules SET
         label                    = COALESCE($1, label),
         direction                = COALESCE($2, direction),
         obligation               = COALESCE($3, obligation),
         operation_group          = COALESCE($4, operation_group),
         pa_transactions_per_item = COALESCE($5, pa_transactions_per_item),
         reason                   = COALESCE($6, reason),
         source_excerpt           = COALESCE($7, source_excerpt),
         confidence               = COALESCE($8, confidence),
         manually_edited          = true
       WHERE id = $9
       RETURNING *`,
      [label, direction, obligation, operation_group,
       pa_transactions_per_item, reason, source_excerpt, confidence, id]
    );

    await logAudit({
      userId:     req.user.id,
      action:     'edit_rule',
      entityType: 'transaction_rule',
      entityId:   id,
      beforeJson: before,
      afterJson:  rows[0],
    });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rule.' });
  }
});

/**
 * POST /api/admin/rules/:id/approve
 * Admin only — approve a proposed rule.
 */
router.post('/rules/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: current } = await db.query(
      `SELECT * FROM transaction_rules WHERE id = $1`,
      [id]
    );
    if (!current.length) return res.status(404).json({ error: 'Rule not found.' });

    const { rows } = await db.query(
      `UPDATE transaction_rules
       SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.id, id]
    );

    await logAudit({
      userId:     req.user.id,
      action:     'approve_rule',
      entityType: 'transaction_rule',
      entityId:   id,
      beforeJson: { status: current[0].status },
      afterJson:  { status: 'approved' },
    });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve rule.' });
  }
});

/**
 * POST /api/admin/rules/:id/reject
 * Admin only — reject a proposed rule.
 */
router.post('/rules/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const { rows: current } = await db.query(
      `SELECT * FROM transaction_rules WHERE id = $1`,
      [id]
    );
    if (!current.length) return res.status(404).json({ error: 'Rule not found.' });

    const { rows } = await db.query(
      `UPDATE transaction_rules
       SET status = 'rejected'
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    await logAudit({
      userId:     req.user.id,
      action:     'reject_rule',
      entityType: 'transaction_rule',
      entityId:   id,
      beforeJson: { status: current[0].status },
      afterJson:  { status: 'rejected', rejection_reason: reason || null },
    });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject rule.' });
  }
});

module.exports = router;
