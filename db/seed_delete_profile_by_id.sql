-- Delete a calculation profile and all dependent rows.
--
-- Replace the UUID below in EVERY statement (search/replace once).
--
-- Railway Data UI: it appends "LIMIT 100" to your query, which breaks
--   DO $$ ... END $$ blocks. Run each statement below ONE AT A TIME.
-- Or use: node scripts/run-psql-file.js db/seed_delete_profile_by_id.sql
--
-- Profile to delete:
--   e78c410c-ad52-4448-8b53-50164d943d8d

-- 1) ai_usage_logs (references scenarios & documents)
DELETE FROM ai_usage_logs
 WHERE scenario_id IN (
   SELECT id FROM scenarios
    WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid
 );

DELETE FROM ai_usage_logs
 WHERE document_id IN (
   SELECT id FROM documents
    WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid
 );

-- 2) scenarios (must be before plans — scenarios.recommended_plan_id → plans)
DELETE FROM scenarios
 WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid;

DELETE FROM document_analyses
 WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid;

DELETE FROM transaction_rules
 WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid;

DELETE FROM plans
 WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid;

DELETE FROM assumptions
 WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid;

DELETE FROM documents
 WHERE profile_id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid;

DELETE FROM calculation_profiles
 WHERE id = 'e78c410c-ad52-4448-8b53-50164d943d8d'::uuid;
