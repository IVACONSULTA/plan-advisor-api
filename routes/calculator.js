const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { requireAuth } = require('../lib/supabase');

/**
 * GET /api/calculator/available-countries
 * All authenticated users — list country+provider combinations with an active profile.
 */
router.get('/available-countries', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cp.id AS profile_id, cp.version, cp.currency, cp.active_from,
              co.id AS country_id, co.code AS country_code, co.name AS country_name,
              pr.id AS provider_id, pr.name AS provider_name, pr.type AS provider_type
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       WHERE cp.status = 'active'
       ORDER BY co.name, pr.name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch available countries.' });
  }
});

/**
 * GET /api/calculator/profile/:id
 * All authenticated users — return the dynamic input fields for a profile.
 * Client users only see active profiles.
 */
router.get('/profile/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const profileResult = await db.query(
      `SELECT cp.id, cp.version, cp.currency, cp.calculation_basis, cp.status,
              co.name AS country_name, pr.name AS provider_name
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       WHERE cp.id = $1`,
      [id]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const profile = profileResult.rows[0];

    // Client users can only access active profiles
    if (req.userRole === 'client' && profile.status !== 'active') {
      return res.status(403).json({ error: 'Profile is not active.' });
    }

    const { rows: rules } = await db.query(
      `SELECT id, input_key, label, direction, obligation,
              operation_group, pa_transactions_per_item
       FROM transaction_rules
       WHERE profile_id = $1 AND status = 'approved'
       ORDER BY label ASC`,
      [id]
    );

    res.json({
      profile_id:        profile.id,
      country_name:      profile.country_name,
      provider_name:     profile.provider_name,
      version:           profile.version,
      currency:          profile.currency,
      calculation_basis: profile.calculation_basis,
      inputs: rules.map((r) => ({
        key:                       r.input_key,
        label:                     r.label,
        direction:                 r.direction,
        obligation:                r.obligation,
        operation_group:           r.operation_group,
        pa_transactions_per_item:  parseFloat(r.pa_transactions_per_item),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch profile inputs.' });
  }
});

/**
 * POST /api/calculator/calculate
 * All authenticated users — deterministic calculation. No AI calls.
 *
 * Body:
 *   profile_id  — uuid of the active calculation profile
 *   client_name — string entered by user
 *   inputs      — { [input_key]: number, ... }
 */
router.post('/calculate', requireAuth, async (req, res) => {
  const { profile_id, client_name, inputs } = req.body;

  if (!profile_id || !inputs || typeof inputs !== 'object') {
    return res.status(400).json({ error: 'profile_id and inputs object are required.' });
  }

  try {
    // 1. Load profile
    const profileResult = await db.query(
      `SELECT cp.*, cp.currency,
              co.name AS country_name, pr.name AS provider_name
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       WHERE cp.id = $1`,
      [profile_id]
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    const profile = profileResult.rows[0];

    if (req.userRole === 'client' && profile.status !== 'active') {
      return res.status(403).json({ error: 'Profile is not active.' });
    }

    // 2. Load approved transaction rules
    const { rows: rules } = await db.query(
      `SELECT input_key, label, direction, obligation,
              operation_group, pa_transactions_per_item
       FROM transaction_rules
       WHERE profile_id = $1 AND status = 'approved'`,
      [profile_id]
    );

    if (!rules.length) {
      return res.status(422).json({ error: 'Profile has no approved rules. Cannot calculate.' });
    }

    // 3. Calculate total PA transactions and build breakdown
    let totalPaTransactions = 0;
    const transactionBreakdown = rules.map((rule) => {
      const volume         = parseFloat(inputs[rule.input_key] ?? 0);
      const multiplier     = parseFloat(rule.pa_transactions_per_item);
      const paTransactions = volume * multiplier;
      totalPaTransactions += paTransactions;

      return {
        input_key:                rule.input_key,
        label:                    rule.label,
        direction:                rule.direction,
        obligation:               rule.obligation,
        operation_group:          rule.operation_group,
        volume,
        pa_transactions_per_item: multiplier,
        pa_transactions:          paTransactions,
      };
    });

    // 4. Load approved plans and calculate cost for each
    const { rows: plans } = await db.query(
      `SELECT id, plan_name, included_pa_transactions,
              annual_fee, monthly_fee, extra_transaction_cost
       FROM plans
       WHERE profile_id = $1 AND status = 'approved'
       ORDER BY annual_fee ASC`,
      [profile_id]
    );

    if (!plans.length) {
      return res.status(422).json({ error: 'Profile has no approved plans. Cannot calculate.' });
    }

    const planComparison = plans.map((plan) => {
      const included       = parseFloat(plan.included_pa_transactions);
      const annualFee      = parseFloat(plan.annual_fee);
      const extraCost      = parseFloat(plan.extra_transaction_cost);
      const excessTx       = Math.max(0, totalPaTransactions - included);
      const totalCost      = annualFee + excessTx * extraCost;

      return {
        plan_id:                 plan.id,
        plan_name:               plan.plan_name,
        included_pa_transactions: included,
        annual_fee:              annualFee,
        monthly_fee:             plan.monthly_fee ? parseFloat(plan.monthly_fee) : null,
        extra_transaction_cost:  extraCost,
        excess_pa_transactions:  excessTx,
        total_annual_cost:       Math.round(totalCost * 100) / 100,
      };
    });

    // 5. Recommend the plan with the lowest total cost
    const recommended = planComparison.reduce(
      (best, p) => (p.total_annual_cost < best.total_annual_cost ? p : best)
    );

    const result = {
      profile_id,
      country_name:        profile.country_name,
      provider_name:       profile.provider_name,
      version:             profile.version,
      currency:            profile.currency,
      total_pa_transactions: Math.round(totalPaTransactions * 100) / 100,
      transaction_breakdown: transactionBreakdown,
      plan_comparison:     planComparison,
      recommended_plan:    recommended,
    };

    // 6. Persist as a scenario
    const { rows: scenario } = await db.query(
      `INSERT INTO scenarios
         (client_name, profile_id, input_json, result_json, recommended_plan_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [
        client_name || null,
        profile_id,
        JSON.stringify(inputs),
        JSON.stringify(result),
        recommended.plan_id,
        req.user.id,
      ]
    );

    res.json({
      scenario_id: scenario[0].id,
      created_at:  scenario[0].created_at,
      ...result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Calculation failed.' });
  }
});

module.exports = router;
