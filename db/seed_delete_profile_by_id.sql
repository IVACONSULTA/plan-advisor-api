-- Delete a calculation profile and all dependent rows (Railway Data UI / psql).
-- Set pid below, then run the whole block.
DO $$
DECLARE
  pid uuid := 'e78c410c-ad52-4448-8b53-50164d943d8d';
BEGIN
  -- ai_usage_logs → scenarios / documents (blocks scenario & document deletes)
  DELETE FROM ai_usage_logs
   WHERE scenario_id IN (SELECT id FROM scenarios WHERE profile_id = pid);
  DELETE FROM ai_usage_logs
   WHERE document_id IN (SELECT id FROM documents WHERE profile_id = pid);

  -- scenarios.recommended_plan_id → plans (blocks plan delete if scenarios remain)
  UPDATE scenarios SET recommended_plan_id = NULL WHERE profile_id = pid;

  DELETE FROM scenarios          WHERE profile_id = pid;
  DELETE FROM document_analyses  WHERE profile_id = pid;
  DELETE FROM transaction_rules  WHERE profile_id = pid;
  DELETE FROM plans              WHERE profile_id = pid;
  DELETE FROM assumptions        WHERE profile_id = pid;
  DELETE FROM documents          WHERE profile_id = pid;
  DELETE FROM calculation_profiles WHERE id = pid;
END $$;
