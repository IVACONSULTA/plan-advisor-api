-- =============================================================================
-- Seed: France × B2Brouter — PA transaction calculator (v1.0)
-- Based on: docs/france_pa_transaction_plan_calculator*.xlsx and
--           docs/Transactions in France.xlsx (deadlines as assumptions)
--
-- Run ONCE against Railway PostgreSQL (or safe to re-run — deletes prior seed
-- rows for the same profile version only).
--
-- Requirements:
--   • At least one active users_profile with role = 'admin'
--   • Schema from db/schema.sql already applied
--
-- Railway (public URL example — use your own):
--   psql "postgresql://..." -f db/seed_france_b2brouter_v1.sql
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

-- ─── 3. Provider B2Brouter (PDP for now) ────────────────────────────────────
INSERT INTO providers (name, type)
SELECT 'B2Brouter', 'PDP'
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'B2Brouter');

UPDATE providers SET type = 'PDP' WHERE name = 'B2Brouter';

-- ─── 4. Calculation profile v1.0 (active) ───────────────────────────────────
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
  'v1.0',
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
WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v1.0';

-- ─── 5. Replace existing rules / plans / assumptions for this profile only ──
DELETE FROM transaction_rules
WHERE profile_id = (SELECT profile_id FROM _seed_profile);

DELETE FROM plans
WHERE profile_id = (SELECT profile_id FROM _seed_profile);

DELETE FROM assumptions
WHERE profile_id = (SELECT profile_id FROM _seed_profile);

-- ─── 6. Transaction rules (approved) — mirrors “Plan Calculator” input grid ───
-- Multipliers match workbook notes: issued = 2 PA tx / invoice (invoice + fiscal report);
-- received domestic/foreign invoice lines = 1 PA tx / invoice;
-- daily reporting row = 1 PA tx per reporting day (user enters annual days).

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
  ('issued_b2b_domestic',
   'B2B invoice to a French customer (annual count of invoices)',
   'Issued', 'E-invoicing', 'Domestic e-invoicing',
   2::numeric,
   'Workbook: domestic e-invoicing; 2 PA transactions per invoice (invoice + fiscal report).',
   'Paraphrased from internal France plan calculator workbook.'),

  ('issued_credit_note_domestic',
   'Credit note / corrective invoice to a French customer (annual count)',
   'Issued', 'E-invoicing', 'Domestic e-invoicing',
   2::numeric,
   'Workbook: same 2 PA transactions treatment as standard B2B issued invoices.',
   'Paraphrased from internal France plan calculator workbook.'),

  ('issued_b2b_foreign_er',
   'B2B invoice to a foreign customer — e-reporting (annual count)',
   'Issued', 'E-reporting', 'E-reporting',
   2::numeric,
   'Workbook: e-reporting path for foreign B2B customer; 2 PA transactions per invoice.',
   'Paraphrased from internal France plan calculator workbook.'),

  ('issued_b2c_consumer_er',
   'B2C invoice to a French consumer — B2C e-reporting (annual count)',
   'Issued', 'E-reporting', 'B2C e-reporting',
   2::numeric,
   'Workbook: B2C invoice-by-invoice e-reporting; 2 PA transactions per invoice.',
   'Paraphrased from internal France plan calculator workbook.'),

  ('issued_payment_er',
   'Reportable payments where VAT is due on collection (annual count of reports)',
   'Issued', 'Payment e-reporting', 'Payment e-reporting',
   1::numeric,
   'Workbook: 1 PA transaction per applicable payment report.',
   'Paraphrased from internal France plan calculator workbook.'),

  ('received_domestic_supplier',
   'Invoice from a French supplier — incoming domestic e-invoicing (annual count)',
   'Received', 'E-invoicing', 'Incoming domestic e-invoicing',
   1::numeric,
   'Workbook: 1 PA transaction per invoice received.',
   'Paraphrased from internal France plan calculator workbook.'),

  ('received_foreign_supplier_er',
   'Invoice from a foreign supplier — international purchase e-reporting (annual count)',
   'Received', 'E-reporting', 'International purchase e-reporting',
   1::numeric,
   'Workbook: 1 PA transaction per invoice received.',
   'Paraphrased from internal France plan calculator workbook.'),

  ('received_foreign_daily_report_days',
   'Daily reporting for foreign supplier invoices (annual number of reporting days)',
   'Received', 'E-reporting', 'International purchase e-reporting',
   1::numeric,
   'Workbook: enter the annual number of days where daily reporting applies; 1 PA transaction per day.',
   'Paraphrased from internal France plan calculator workbook.')
) AS v(input_key, label, direction, obligation, operation_group, mult, reason, excerpt);

-- ─── 7. Plans (approved) — “Plan comparison” ladder from workbook ─────────────
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
  'Paraphrased from internal France B2Brouter plan tariff workbook.',
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

-- ─── 8. Assumptions — high-level France mandate dates from “Transactions…” ───
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
  ('fr_mandate_domestic_issued_deadline',
   '01/09/2026 (large companies) or 01/09/2027 (others)',
   'Paraphrased from internal France transactions overview workbook (domestic issued).'),
  ('fr_mandate_domestic_received_deadline',
   '01/09/2026 (all companies)',
   'Paraphrased from internal France transactions overview workbook (domestic received).'),
  ('fr_mandate_non_domestic_issued_deadline',
   '01/09/2026 (large companies) or 01/09/2027 (others)',
   'Paraphrased from internal France transactions overview workbook (non-domestic issued).'),
  ('fr_mandate_non_domestic_received_deadline',
   '01/09/2027 (all companies)',
   'Paraphrased from internal France transactions overview workbook (non-domestic received).')
) AS v(akey, avalue, areason);

COMMIT;

-- ─── Verify (optional) ───────────────────────────────────────────────────────
-- SELECT id FROM calculation_profiles cp
-- JOIN countries c ON c.id = cp.country_id
-- JOIN providers p ON p.id = cp.provider_id
-- WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v1.0';
--
-- SELECT input_key, pa_transactions_per_item, status
-- FROM transaction_rules WHERE profile_id = '<profile_uuid>';
--
-- SELECT plan_name, included_pa_transactions, annual_fee, extra_transaction_cost, status
-- FROM plans WHERE profile_id = '<profile_uuid>';
