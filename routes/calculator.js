const express = require("express");
const router = express.Router();
const db = require("../lib/db");
const { requireAuth } = require("../lib/supabase");

/** Optional body from the calculator UI — saved in scenarios.input_json for other screens. */
function sanitizeCalculatorForm(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.groups)) {
    return null;
  }
  const groups = [];
  for (const g of raw.groups) {
    if (!g || typeof g !== "object") continue;
    const display_label = String(g.display_label ?? "").trim();
    const input_keys = Array.isArray(g.input_keys)
      ? g.input_keys.map((k) => String(k).trim()).filter(Boolean)
      : [];
    if (!display_label || !input_keys.length) continue;
    groups.push({ display_label, input_keys });
  }
  return groups.length ? { groups } : null;
}

function displayLabelMapFromForm(form) {
  const m = new Map();
  if (!form?.groups) return m;
  for (const g of form.groups) {
    const label = String(g.display_label ?? "").trim();
    if (!label) continue;
    for (const k of g.input_keys ?? []) {
      if (k) m.set(k, label);
    }
  }
  return m;
}

/** Merge key: same tuple → one calculator row / one breakdown row (deterministic). */
function ruleMergeBucketKey(rule) {
  const og =
    rule.operation_group != null ? String(rule.operation_group).trim() : "";
  const dir = rule.direction != null ? String(rule.direction).trim() : "";
  const obl = rule.obligation != null ? String(rule.obligation).trim() : "";
  let mult = parseFloat(rule.pa_transactions_per_item);
  if (!Number.isFinite(mult)) mult = 0;
  const multKey = Math.round(mult * 1e9) / 1e9;
  return JSON.stringify([og, dir, obl, multKey]);
}

function bucketRulesByMergeKey(rules) {
  const bucket = new Map();
  const order = [];
  for (const rule of rules) {
    const k = ruleMergeBucketKey(rule);
    if (!bucket.has(k)) {
      bucket.set(k, []);
      order.push(k);
    }
    bucket.get(k).push(rule);
  }
  return order.map((k) => bucket.get(k));
}

const { calculatorRuleGroupsCountSelect } = require("../lib/calculator-rules-count");

/**
 * GET /api/calculator/available-countries
 * All authenticated users — list country+provider combinations with an active profile.
 */
router.get("/available-countries", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cp.id AS profile_id, cp.version, cp.currency, cp.active_from,
              co.id AS country_id, co.code AS country_code, co.name AS country_name,
              pr.id AS provider_id, pr.name AS provider_name, pr.type AS provider_type,
              ${calculatorRuleGroupsCountSelect()} AS rules_count,
              (SELECT COUNT(*)::int FROM plans pl
                 WHERE pl.profile_id = cp.id AND pl.status = 'approved') AS plans_count
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       WHERE cp.status = 'active'
       ORDER BY co.name, pr.name`,
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch available countries." });
  }
});

/**
 * GET /api/calculator/profile/:id
 * All authenticated users — return the dynamic input fields for a profile.
 * Client users only see active profiles.
 */
router.get("/profile/:id", requireAuth, async (req, res) => {
  const { id } = req.params;

  try {
    const profileResult = await db.query(
      `SELECT cp.id, cp.version, cp.currency, cp.calculation_basis, cp.status,
              co.name AS country_name, pr.name AS provider_name
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       WHERE cp.id = $1`,
      [id],
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: "Profile not found." });
    }

    const profile = profileResult.rows[0];

    // Client users can only access active profiles
    if (req.userRole === "client" && profile.status !== "active") {
      return res.status(403).json({ error: "Profile is not active." });
    }

    const { rows: rules } = await db.query(
      `SELECT id, input_key, label, direction, obligation,
              operation_group, pa_transactions_per_item, index_ui
       FROM transaction_rules
       WHERE profile_id = $1 AND status = 'approved'
       ORDER BY index_ui NULLS LAST, operation_group NULLS LAST, label ASC`,
      [id],
    );

    res.json({
      profile_id: profile.id,
      country_name: profile.country_name,
      provider_name: profile.provider_name,
      version: profile.version,
      currency: profile.currency,
      calculation_basis: profile.calculation_basis,
      inputs: rules.map((r) => ({
        key: r.input_key,
        label: r.label,
        direction: r.direction,
        obligation: r.obligation,
        operation_group: r.operation_group,
        pa_transactions_per_item: parseFloat(r.pa_transactions_per_item),
        index_ui: r.index_ui != null ? parseInt(r.index_ui, 10) : null,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch profile inputs." });
  }
});

/**
 * POST /api/calculator/calculate
 * All authenticated users — deterministic calculation. No AI calls.
 *
 * Body:
 *   profile_id        — uuid of the active calculation profile
 *   client_name       — string entered by user
 *   inputs            — { [input_key]: number, ... }
 *   calculator_form   — optional { groups: [{ display_label, input_keys: string[] }] }
 *                       (mirrors the grouped calculator fields; used for labels + stored in input_json)
 */
router.post("/calculate", requireAuth, async (req, res) => {
  const { profile_id, client_name, inputs, calculator_form: rawForm } = req.body;

  if (!profile_id || !inputs || typeof inputs !== "object") {
    return res
      .status(400)
      .json({ error: "profile_id and inputs object are required." });
  }

  const calculator_form = sanitizeCalculatorForm(rawForm);
  const formLabelByKey = displayLabelMapFromForm(calculator_form);

  try {
    // 1. Load profile
    const profileResult = await db.query(
      `SELECT cp.*, cp.currency,
              co.name AS country_name, pr.name AS provider_name
       FROM calculation_profiles cp
       JOIN countries co ON co.id = cp.country_id
       JOIN providers pr ON pr.id = cp.provider_id
       WHERE cp.id = $1`,
      [profile_id],
    );

    if (!profileResult.rows.length) {
      return res.status(404).json({ error: "Profile not found." });
    }

    const profile = profileResult.rows[0];

    if (req.userRole === "client" && profile.status !== "active") {
      return res.status(403).json({ error: "Profile is not active." });
    }

    // 2. Load approved transaction rules
    const { rows: rules } = await db.query(
      `SELECT input_key, label, direction, obligation,
              operation_group, pa_transactions_per_item, index_ui
       FROM transaction_rules
       WHERE profile_id = $1 AND status = 'approved'
       ORDER BY index_ui NULLS LAST, operation_group NULLS LAST,
                direction, obligation, pa_transactions_per_item, label ASC`,
      [profile_id],
    );

    if (!rules.length) {
      return res
        .status(422)
        .json({ error: "Profile has no approved rules. Cannot calculate." });
    }

    // 3. Calculate total PA transactions and build breakdown (one row per merge bucket)
    const ruleGroups = bucketRulesByMergeKey(rules);
    let totalPaTransactions = 0;
    const transactionBreakdown = [];

    for (const groupRules of ruleGroups) {
      const mult = parseFloat(groupRules[0].pa_transactions_per_item);
      const first = groupRules[0];
      const vols = groupRules.map((r) => parseFloat(inputs[r.input_key] ?? 0));
      let paSum = 0;
      for (let i = 0; i < groupRules.length; i++) {
        paSum += vols[i] * mult;
      }
      totalPaTransactions += paSum;

      const allSameVol = vols.every((v) => v === vols[0]);
      const volumeDisplay = allSameVol
        ? vols[0]
        : vols.reduce((acc, v) => acc + v, 0);

      let fromForm = null;
      for (const r of groupRules) {
        const fl = formLabelByKey.get(r.input_key);
        if (fl && fl.length) {
          fromForm = fl;
          break;
        }
      }

      const og =
        first.operation_group && String(first.operation_group).trim()
          ? String(first.operation_group).trim()
          : "";
      const typeLabel =
        (fromForm && fromForm.length ? fromForm : null) || og || first.label;

      const uniqueRuleLabels = [
        ...new Set(groupRules.map((r) => r.label)),
      ];
      const combinedRuleLabels = uniqueRuleLabels.join(" · ");

      const row = {
        input_key: first.input_key,
        input_keys: groupRules.map((r) => r.input_key),
        label: typeLabel,
        direction: first.direction,
        obligation: first.obligation,
        operation_group: first.operation_group,
        volume: volumeDisplay,
        pa_transactions_per_item: mult,
        pa_transactions: paSum,
      };

      if (groupRules.length > 1) {
        if (uniqueRuleLabels.length > 1) {
          row.detail_label = combinedRuleLabels;
        } else if (
          uniqueRuleLabels.length === 1 &&
          String(uniqueRuleLabels[0]) !== String(typeLabel)
        ) {
          row.detail_label = uniqueRuleLabels[0];
        }
      } else if (typeLabel !== first.label) {
        row.detail_label = first.label;
      }

      transactionBreakdown.push(row);
    }

    // 4. Load approved plans and calculate cost for each
    const { rows: plans } = await db.query(
      `SELECT id, plan_name, included_pa_transactions,
              annual_fee, monthly_fee, extra_transaction_cost
       FROM plans
       WHERE profile_id = $1 AND status = 'approved'
       ORDER BY annual_fee ASC`,
      [profile_id],
    );

    if (!plans.length) {
      return res
        .status(422)
        .json({ error: "Profile has no approved plans. Cannot calculate." });
    }

    const planComparison = plans.map((plan) => {
      const included = parseFloat(plan.included_pa_transactions);
      const annualFee = parseFloat(plan.annual_fee);
      const extraCost = parseFloat(plan.extra_transaction_cost);
      const excessTx = Math.max(0, totalPaTransactions - included);
      const totalCost = annualFee + excessTx * extraCost;

      return {
        plan_id: plan.id,
        plan_name: plan.plan_name,
        included_pa_transactions: included,
        annual_fee: annualFee,
        monthly_fee: plan.monthly_fee ? parseFloat(plan.monthly_fee) : null,
        extra_transaction_cost: extraCost,
        excess_pa_transactions: excessTx,
        total_annual_cost: Math.round(totalCost * 100) / 100,
      };
    });

    // 5. Recommend the plan with the lowest total cost
    const recommended = planComparison.reduce((best, p) =>
      p.total_annual_cost < best.total_annual_cost ? p : best,
    );

    const result = {
      profile_id,
      country_name: profile.country_name,
      provider_name: profile.provider_name,
      version: profile.version,
      currency: profile.currency,
      total_pa_transactions: Math.round(totalPaTransactions * 100) / 100,
      transaction_breakdown: transactionBreakdown,
      plan_comparison: planComparison,
      recommended_plan: recommended,
    };

    // 6. Persist as a scenario (company_id from profile for client/team filtering)
    const { rows: upRows } = await db.query(
      `SELECT company_id FROM users_profile WHERE id = $1`,
      [req.user.id],
    );
    const companyId = upRows[0]?.company_id ?? null;

    const inputPayload = { inputs };
    if (calculator_form) {
      inputPayload.calculator_form = calculator_form;
    }

    const { rows: scenario } = await db.query(
      `INSERT INTO scenarios
         (company_id, client_name, profile_id, input_json, result_json, recommended_plan_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        companyId,
        client_name || null,
        profile_id,
        JSON.stringify(inputPayload),
        JSON.stringify(result),
        recommended.plan_id,
        req.user.id,
      ],
    );

    res.json({
      scenario_id: scenario[0].id,
      created_at: scenario[0].created_at,
      ...result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Calculation failed." });
  }
});

module.exports = router;
