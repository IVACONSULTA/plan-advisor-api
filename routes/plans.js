const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth, requireAdmin } = require('../lib/supabase');
const { logAudit } = require('../lib/audit');

/**
 * PATCH /api/admin/plans/:id
 * Admin only — edit a proposed plan.
 */
router.patch('/plans/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    plan_name, included_pa_transactions, annual_fee,
    monthly_fee, extra_transaction_cost, source_excerpt, confidence,
  } = req.body;

  try {
    const { rows: current } = await db.query(
      `SELECT * FROM plans WHERE id = $1`,
      [id]
    );
    if (!current.length) return res.status(404).json({ error: 'Plan not found.' });

    const before = current[0];

    const { rows } = await db.query(
      `UPDATE plans SET
         plan_name                = COALESCE($1, plan_name),
         included_pa_transactions = COALESCE($2, included_pa_transactions),
         annual_fee               = COALESCE($3, annual_fee),
         monthly_fee              = COALESCE($4, monthly_fee),
         extra_transaction_cost   = COALESCE($5, extra_transaction_cost),
         source_excerpt           = COALESCE($6, source_excerpt),
         confidence               = COALESCE($7, confidence)
       WHERE id = $8
       RETURNING *`,
      [plan_name, included_pa_transactions, annual_fee,
       monthly_fee, extra_transaction_cost, source_excerpt, confidence, id]
    );

    await logAudit({
      userId:     req.user.id,
      action:     'edit_plan',
      entityType: 'plan',
      entityId:   id,
      beforeJson: before,
      afterJson:  rows[0],
    });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update plan.' });
  }
});

/**
 * POST /api/admin/plans/:id/approve
 * Admin only — approve a proposed plan.
 */
router.post('/plans/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: current } = await db.query(
      `SELECT * FROM plans WHERE id = $1`,
      [id]
    );
    if (!current.length) return res.status(404).json({ error: 'Plan not found.' });

    const { rows } = await db.query(
      `UPDATE plans
       SET status = 'approved', approved_by = $1, approved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.id, id]
    );

    await logAudit({
      userId:     req.user.id,
      action:     'approve_plan',
      entityType: 'plan',
      entityId:   id,
      beforeJson: { status: current[0].status },
      afterJson:  { status: 'approved' },
    });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve plan.' });
  }
});

/**
 * POST /api/admin/plans/:id/reject
 * Admin only — reject a proposed plan.
 */
router.post('/plans/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: current } = await db.query(
      `SELECT * FROM plans WHERE id = $1`,
      [id]
    );
    if (!current.length) return res.status(404).json({ error: 'Plan not found.' });

    const { rows } = await db.query(
      `UPDATE plans SET status = 'rejected' WHERE id = $1 RETURNING *`,
      [id]
    );

    await logAudit({
      userId:     req.user.id,
      action:     'reject_plan',
      entityType: 'plan',
      entityId:   id,
      beforeJson: { status: current[0].status },
      afterJson:  { status: 'rejected' },
    });

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject plan.' });
  }
});

module.exports = router;
