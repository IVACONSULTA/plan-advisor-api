/**
 * Calculator UI shows one row per distinct merge of:
 *   operation_group (trimmed), direction, obligation, pa_transactions_per_item (9dp)
 * (same as `transactionRuleMergeBucketKey` in PlanAdvisorFront `calculator-rule-groups.ts`).
 *
 * Use in SELECT lists where `calculation_profiles` is aliased as `cp`.
 */
function calculatorRuleGroupsCountSelect() {
  return `(SELECT COUNT(*)::int FROM (
    SELECT DISTINCT
      TRIM(COALESCE(tr.operation_group, '')) AS og,
      TRIM(COALESCE(tr.direction::text, '')) AS dir,
      TRIM(COALESCE(tr.obligation::text, '')) AS obl,
      ROUND(COALESCE(tr.pa_transactions_per_item, 0)::numeric, 9) AS mult
    FROM transaction_rules tr
    WHERE tr.profile_id = cp.id AND tr.status = 'approved'
  ) merged)`;
}

module.exports = { calculatorRuleGroupsCountSelect };
