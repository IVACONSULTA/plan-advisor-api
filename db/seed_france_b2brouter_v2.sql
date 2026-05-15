-- =============================================================================
-- Seed: France × B2Brouter — PA transaction calculator (v2.0)
-- Based on: "Transactions in France2.xlsx" with updated example volumes
--           and Flux reference numbers (10.1, 10.2, 10.3, 10.4)
--
-- Run ONCE against Railway PostgreSQL (or safe to re-run — deletes prior seed
-- rows for the same profile version only).
--
-- Requirements:
--   • At least one active users_profile with role = 'admin'
--   • Schema from db/schema.sql already applied
--
-- Railway (public URL example — use your own):
--   psql "postgresql://..." -f db/seed_france_b2brouter_v2.sql
-- =============================================================================

BEGIN;

-- ─── 1. Resolve admin user (must exist) ─────────────────────────────────────
DO $$
DECLARE
  v_admin_id uuid;
BEGIN
  SELECT id INTO v_admin_id
  FROM users_profile
  WHERE role = 'admin' AND active = true
  ORDER BY created_at
  LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION
      'No active admin in users_profile. Create an admin first (Supabase + users_profile).';
  END IF;
END $$;

-- ─── 2. Country France ─────────────────────────────────────────────────────
INSERT INTO countries (code, name, created_by)
SELECT
  'FR',
  'France',
  up.id
FROM users_profile up
WHERE up.role = 'admin' AND up.active = true
ORDER BY up.created_at
LIMIT 1
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name;

-- ─── 3. Provider B2Brouter (PDP) ────────────────────────────────────────────
INSERT INTO providers (name, type)
SELECT 'B2Brouter', 'PDP'
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'B2Brouter');

UPDATE providers SET type = 'PDP' WHERE name = 'B2Brouter';

-- ─── 4. Archive old profiles for FR × B2Brouter ─────────────────────────────
UPDATE calculation_profiles
SET status = 'archived',
    active_to = CURRENT_DATE
WHERE id IN (
  SELECT cp.id
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter'
    AND cp.status = 'active'
    AND cp.version != 'v2.0'
);

-- Log archival
DO $$
DECLARE
  v_archived_count int;
BEGIN
  SELECT COUNT(*) INTO v_archived_count
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter'
    AND cp.status = 'archived'
    AND cp.version != 'v2.0';
  
  IF v_archived_count > 0 THEN
    RAISE NOTICE '✓ Archived % old profile(s) for FR × B2Brouter', v_archived_count;
  ELSE
    RAISE NOTICE '  No old profiles to archive (this is the first version)';
  END IF;
END $$;

-- ─── 5. Calculation profile v2.0 (new active profile) ───────────────────────
INSERT INTO calculation_profiles (
  country_id,
  provider_id,
  version,
  currency,
  status,
  calculation_basis,
  active_from,
  created_by,
  approved_by,
  approved_at
)
SELECT
  c.id,
  p.id,
  'v2.0',
  'EUR',
  'active',
  'PA transactions',
  CURRENT_DATE,
  up.id,
  up.id,
  NOW()
FROM countries c
CROSS JOIN providers p
CROSS JOIN LATERAL (
  SELECT id FROM users_profile
  WHERE role = 'admin' AND active = true
  ORDER BY created_at LIMIT 1
) up
WHERE c.code = 'FR' AND p.name = 'B2Brouter'
ON CONFLICT (country_id, provider_id, version) DO UPDATE SET
  status       = 'active',
  currency     = EXCLUDED.currency,
  calculation_basis = EXCLUDED.calculation_basis,
  active_from  = COALESCE(calculation_profiles.active_from, EXCLUDED.active_from),
  approved_by  = EXCLUDED.approved_by,
  approved_at  = EXCLUDED.approved_at;

-- Profile id for subsequent DML
CREATE TEMP TABLE _seed_profile ON COMMIT DROP AS
SELECT cp.id AS profile_id
FROM calculation_profiles cp
JOIN countries  c ON c.id = cp.country_id
JOIN providers  p ON p.id = cp.provider_id
WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0';

-- ─── 6. Verify profile was found ────────────────────────────────────────────
DO $$
DECLARE
  v_profile_count int;
  v_profile_id uuid;
BEGIN
  SELECT COUNT(*), MAX(profile_id) INTO v_profile_count, v_profile_id
  FROM _seed_profile;
  
  IF v_profile_count = 0 THEN
    RAISE EXCEPTION 'Profile v2.0 not found. Check that FR country and B2Brouter provider exist.';
  END IF;
  
  RAISE NOTICE 'Found profile v2.0: %', v_profile_id;
END $$;

-- ─── 7. Replace existing rules / plans / assumptions for this profile only ──
DELETE FROM transaction_rules
WHERE profile_id = (SELECT profile_id FROM _seed_profile);

DELETE FROM plans
WHERE profile_id = (SELECT profile_id FROM _seed_profile);

DELETE FROM assumptions
WHERE profile_id = (SELECT profile_id FROM _seed_profile);

-- ─── 8. Transaction rules (approved) — updated from "Transactions in France2.xlsx" ───
-- Example volumes from workbook:
--   • Domestic B2B Issued: 1,000 invoices → 2,000 PA transactions (Flux 1 & 2)
--   • Domestic B2B Received: 500 invoices → 500 PA transactions (Recepción)
--   • International B2B Issued: 2,000 invoices → 2,000 PA transactions (Envío)
--   • International B2B Received: 100 invoices → 100 PA transactions (Recepción)
--   • Daily reports: 31 days for various Flux (10.1, 10.2, 10.3, 10.4)

INSERT INTO transaction_rules (
  profile_id, input_key, label, direction, obligation, operation_group,
  pa_transactions_per_item, reason, source_excerpt, confidence, status,
  manually_edited, approved_by, approved_at
)
SELECT
  sp.profile_id,
  v.input_key,
  v.label,
  v.direction,
  v.obligation,
  v.operation_group,
  v.mult,
  v.reason,
  v.excerpt,
  'high',
  'approved',
  true,
  up.id,
  NOW()
FROM _seed_profile sp
CROSS JOIN LATERAL (
  SELECT id FROM users_profile
  WHERE role = 'admin' AND active = true
  ORDER BY created_at LIMIT 1
) up
CROSS JOIN LATERAL (VALUES
  -- B2B Domestic Issued (Flux 1 & 2: envío al cliente y DGFiP)
  ('issued_b2b_domestic',
   'B2B invoice to a French customer (annual count of invoices)',
   'Issued', 'E-invoicing', 'Domestic B2B',
   2::numeric,
   'France2.xlsx: Domestic issued invoices; 2 PA transactions per invoice (Flux 1 & 2: invoice to client + fiscal report to DGFiP). Example: 1,000 invoices → 2,000 PA transactions.',
   'Transactions in France2.xlsx - B2B invoicing Domestic Issued'),

  -- B2B Domestic Received (Recepción)
  ('received_domestic_supplier',
   'Invoice from a French supplier — incoming domestic e-invoicing (annual count)',
   'Received', 'E-invoicing', 'Incoming domestic e-invoicing',
   1::numeric,
   'France2.xlsx: Domestic received invoices; 1 PA transaction per invoice (Recepción). Example: 500 invoices → 500 PA transactions.',
   'Transactions in France2.xlsx - B2B invoicing Domestic Received'),

  -- B2B International Issued (Envío al cliente)
  ('issued_b2b_foreign_er',
   'B2B invoice to a foreign customer — e-reporting (annual count)',
   'Issued', 'E-reporting', 'International B2B',
   2::numeric,
   'France2.xlsx: International issued invoices; 2 PA transactions per invoice (Envío al cliente). Example: 2,000 invoices → 2,000 PA transactions.',
   'Transactions in France2.xlsx - B2B invoicing International Issued'),

  -- B2B International Received (Recepción)
  ('received_foreign_supplier_er',
   'Invoice from a foreign supplier — international purchase e-reporting (annual count)',
   'Received', 'E-reporting', 'International purchase e-reporting',
   1::numeric,
   'France2.xlsx: International received invoices; 1 PA transaction per invoice (Recepción). Example: 100 invoices → 100 PA transactions.',
   'Transactions in France2.xlsx - B2B invoicing International Received'),

  -- Daily report: B2B international issued (Flux 10.1) + B2C issued (Flux 10.3)
  ('daily_report_issued_international_b2b_b2c',
   'Daily reporting of issued B2B international (Flux 10.1) and B2C invoices (Flux 10.3) — annual reporting days',
   'Issued', 'E-reporting', 'Daily e-reporting',
   1::numeric,
   'France2.xlsx: 1 PA transaction (e-report) for each day the issuer sends invoices. Example: 31 days → 31 PA transactions.',
   'Transactions in France2.xlsx - Daily report of issued transactions'),

  -- Daily report: International received (Flux 10.1)
  ('daily_report_received_international',
   'Daily reporting of received international invoices (Flux 10.1) — annual reporting days',
   'Received', 'E-reporting', 'Daily e-reporting',
   1::numeric,
   'France2.xlsx: 1 PA transaction (e-report) for each day the recipient receives international invoices. Example: 31 days → 31 PA transactions.',
   'Transactions in France2.xlsx - Daily report of received transactions'),

  -- Daily report: Issued B2B international payments (Flux 10.2)
  ('daily_report_issued_payments_international',
   'Daily reporting of issued B2B international payments (Flux 10.2) — annual reporting days',
   'Issued', 'Payment e-reporting', 'Daily payment e-reporting',
   1::numeric,
   'France2.xlsx: 1 PA transaction (e-report) for each day with international payment activity. Example: 31 days → 31 PA transactions.',
   'Transactions in France2.xlsx - Daily report of issued payments'),

  -- Daily report: Issued B2C payments when TVA sur les encaissements applies (Flux 10.4)
  ('daily_report_issued_payments_b2c_tva',
   'Daily reporting of issued B2C payments when VAT is due on collection (Flux 10.4) — annual reporting days',
   'Issued', 'Payment e-reporting', 'B2C payment e-reporting',
   1::numeric,
   'France2.xlsx: 1 PA transaction (e-report) for each day with B2C payment where VAT is due on collection (TVA sur les encaissements). Example: 31 days → 31 PA transactions.',
   'Transactions in France2.xlsx - Daily report of issued payments')

) AS v(input_key, label, direction, obligation, operation_group, mult, reason, excerpt);

-- ─── 9. Plans (approved) — same pricing tiers as v1.0 ──────────────────────
INSERT INTO plans (
  profile_id, plan_name, included_pa_transactions, annual_fee,
  extra_transaction_cost, status, confidence, source_excerpt,
  approved_by, approved_at
)
SELECT
  sp.profile_id,
  v.plan_name,
  v.included,
  v.fee,
  v.extra,
  'approved',
  'high',
  'France B2Brouter plan tariff workbook (unchanged from v1.0).',
  up.id,
  NOW()
FROM _seed_profile sp
CROSS JOIN LATERAL (
  SELECT id FROM users_profile
  WHERE role = 'admin' AND active = true
  ORDER BY created_at LIMIT 1
) up
CROSS JOIN LATERAL (VALUES
  ('Plan 1',  1200::numeric,   498::numeric,  0.435::numeric),
  ('Plan 2',  3600::numeric,   858::numeric,  0.295::numeric),
  ('Plan 3',  7200::numeric,  1218::numeric,  0.222::numeric),
  ('Plan 4', 18000::numeric,  2178::numeric,  0.169::numeric),
  ('Plan 5', 48000::numeric,  3378::numeric,  0.101::numeric),
  ('Plan 6',120000::numeric,  5178::numeric,  0.063::numeric),
  ('Plan 7',300000::numeric,  7698::numeric,  0.038::numeric),
  ('Plan 8',708000::numeric, 12750::numeric,  0.027::numeric),
  ('Plan 9',1200000::numeric, 16350::numeric,  0.020::numeric)
) AS v(plan_name, included, fee, extra);

-- ─── 10. Assumptions — deadlines and example volumes from France2.xlsx ──────
INSERT INTO assumptions (
  profile_id, key, value, reason, status
)
SELECT
  sp.profile_id,
  v.akey,
  v.avalue,
  v.areason,
  'approved'
FROM _seed_profile sp
CROSS JOIN LATERAL (VALUES
  -- Deadlines (unchanged from v1.0)
  ('fr_mandate_domestic_issued_deadline',
   '01/09/2026 (Large companies) or 01/09/2027 (Rest)',
   'Transactions in France2.xlsx - B2B Domestic Issued invoices mandatory deadline.'),
  
  ('fr_mandate_domestic_received_deadline',
   '01/09/2026 (all companies)',
   'Transactions in France2.xlsx - B2B Domestic Received invoices mandatory deadline.'),
  
  ('fr_mandate_international_issued_deadline',
   '01/09/2026 (Large companies) or 01/09/2027 (Rest)',
   'Transactions in France2.xlsx - B2B International Issued invoices mandatory deadline.'),
  
  ('fr_mandate_international_received_deadline',
   '01/09/2027 (all companies)',
   'Transactions in France2.xlsx - B2B International Received invoices mandatory deadline.'),

  -- Example volumes from France2.xlsx for reference
  ('example_domestic_issued_invoices',
   '1,000 invoices → 2,000 PA transactions',
   'Example from France2.xlsx showing 2x multiplier for domestic issued (Flux 1 & 2).'),
  
  ('example_domestic_received_invoices',
   '500 invoices → 500 PA transactions',
   'Example from France2.xlsx showing 1x multiplier for domestic received.'),
  
  ('example_international_issued_invoices',
   '2,000 invoices → 2,000 PA transactions',
   'Example from France2.xlsx showing 2x multiplier for international issued.'),
  
  ('example_international_received_invoices',
   '100 invoices → 100 PA transactions',
   'Example from France2.xlsx showing 1x multiplier for international received.'),
  
  ('example_daily_reporting_days',
   '31 days per reporting type',
   'Example from France2.xlsx showing daily reporting for various Flux (10.1, 10.2, 10.3, 10.4).'),
  
  ('example_total_annual_transactions',
   '4,693 PA transactions',
   'Total example calculation from France2.xlsx: 1,000 domestic issued (→2,000) + 500 domestic received (→500) + 2,000 intl issued (→2,000) + 100 intl received (→100) + (31×3 daily reports = 93) = 4,693 PA transactions.')

) AS v(akey, avalue, areason);

COMMIT;

-- ─── Final verification ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_profile_id uuid;
  v_rules_count int;
  v_plans_count int;
  v_assumptions_count int;
  v_old_profiles_count int;
BEGIN
  SELECT cp.id INTO v_profile_id
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0';
  
  SELECT COUNT(*) INTO v_rules_count
  FROM transaction_rules WHERE profile_id = v_profile_id;
  
  SELECT COUNT(*) INTO v_plans_count
  FROM plans WHERE profile_id = v_profile_id;
  
  SELECT COUNT(*) INTO v_assumptions_count
  FROM assumptions WHERE profile_id = v_profile_id;
  
  SELECT COUNT(*) INTO v_old_profiles_count
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter'
    AND cp.version != 'v2.0'
    AND cp.status = 'archived';
  
  RAISE NOTICE '✓ Seed complete for profile v2.0 (%):', v_profile_id;
  RAISE NOTICE '  - Transaction rules: %', v_rules_count;
  RAISE NOTICE '  - Plans: %', v_plans_count;
  RAISE NOTICE '  - Assumptions: %', v_assumptions_count;
  RAISE NOTICE '  - Old profiles archived: %', v_old_profiles_count;
  
  IF v_rules_count = 0 OR v_plans_count = 0 THEN
    RAISE WARNING 'No rules or plans were inserted! Check the script.';
  END IF;
END $$;

-- ─── Verify (optional) ───────────────────────────────────────────────────────
-- SELECT id, version, status FROM calculation_profiles cp
-- JOIN countries c ON c.id = cp.country_id
-- JOIN providers p ON p.id = cp.provider_id
-- WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0';
--
-- SELECT input_key, label, pa_transactions_per_item, status
-- FROM transaction_rules 
-- WHERE profile_id = (
--   SELECT cp.id FROM calculation_profiles cp
--   JOIN countries c ON c.id = cp.country_id
--   JOIN providers p ON p.id = cp.provider_id
--   WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0'
-- )
-- ORDER BY input_key;
--
-- SELECT plan_name, included_pa_transactions, annual_fee, extra_transaction_cost, status
-- FROM plans 
-- WHERE profile_id = (
--   SELECT cp.id FROM calculation_profiles cp
--   JOIN countries c ON c.id = cp.country_id
--   JOIN providers p ON p.id = cp.provider_id
--   WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0'
-- )
-- ORDER BY included_pa_transactions;
--
-- SELECT key, value
-- FROM assumptions
-- WHERE profile_id = (
--   SELECT cp.id FROM calculation_profiles cp
--   JOIN countries c ON c.id = cp.country_id
--   JOIN providers p ON p.id = cp.provider_id
--   WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0'
-- )
-- ORDER BY key;
