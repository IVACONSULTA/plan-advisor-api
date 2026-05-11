-- =============================================================================
-- Seed: France × B2Brouter v2.0 (CLEAN INSTALL - No deletes)
-- Use this version if v2.0 doesn't exist yet (avoids "destructive action" warnings)
-- =============================================================================

BEGIN;

-- ─── 1. Resolve admin user ──────────────────────────────────────────────────
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
    RAISE EXCEPTION 'No active admin found. Create an admin user first.';
  END IF;
  
  RAISE NOTICE 'Using admin: %', v_admin_id;
END $$;

-- ─── 2. Country France ──────────────────────────────────────────────────────
INSERT INTO countries (code, name, created_by)
SELECT 'FR', 'France', up.id
FROM users_profile up
WHERE up.role = 'admin' AND up.active = true
ORDER BY up.created_at LIMIT 1
ON CONFLICT (code) DO NOTHING;

-- ─── 3. Provider B2Brouter ──────────────────────────────────────────────────
INSERT INTO providers (name, type)
VALUES ('B2Brouter', 'PDP')
ON CONFLICT (name) DO UPDATE SET type = 'PDP';

-- ─── 4. Deactivate old profiles for FR × B2Brouter ──────────────────────────
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

-- Log deactivation
DO $$
DECLARE
  v_deactivated_count int;
BEGIN
  SELECT COUNT(*) INTO v_deactivated_count
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter'
    AND cp.status = 'archived'
    AND cp.version != 'v2.0';
  
  IF v_deactivated_count > 0 THEN
    RAISE NOTICE '✓ Archived % old profile(s) for FR × B2Brouter', v_deactivated_count;
  ELSE
    RAISE NOTICE '  No old profiles to archive (this is the first version)';
  END IF;
END $$;

-- ─── 5. Calculation profile v2.0 (new active profile) ───────────────────────
INSERT INTO calculation_profiles (
  country_id, provider_id, version, currency, status,
  calculation_basis, active_from, created_by, approved_by, approved_at
)
SELECT
  c.id, p.id, 'v2.0', 'EUR', 'active',
  'PA transactions', CURRENT_DATE, up.id, up.id, NOW()
FROM countries c, providers p, LATERAL (
  SELECT id FROM users_profile
  WHERE role = 'admin' AND active = true
  ORDER BY created_at LIMIT 1
) up
WHERE c.code = 'FR' AND p.name = 'B2Brouter'
ON CONFLICT (country_id, provider_id, version) DO UPDATE
SET status = 'active',
    approved_by = EXCLUDED.approved_by,
    approved_at = EXCLUDED.approved_at;

-- Get the profile ID
DO $$
DECLARE
  v_profile_id uuid;
  v_existing_rules int;
BEGIN
  SELECT cp.id INTO v_profile_id
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0';
  
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'Profile v2.0 not found after insert!';
  END IF;
  
  -- Check if rules already exist
  SELECT COUNT(*) INTO v_existing_rules
  FROM transaction_rules WHERE profile_id = v_profile_id;
  
  IF v_existing_rules > 0 THEN
    RAISE EXCEPTION 'Profile v2.0 already has % transaction rules. Use the full seed_france_b2brouter_v2.sql to update.', v_existing_rules;
  END IF;
  
  RAISE NOTICE '✓ Profile v2.0 ready: %', v_profile_id;
END $$;

-- ─── 6. Transaction rules ───────────────────────────────────────────────────
WITH profile AS (
  SELECT cp.id AS profile_id
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0'
),
admin AS (
  SELECT id FROM users_profile
  WHERE role = 'admin' AND active = true
  ORDER BY created_at LIMIT 1
)
INSERT INTO transaction_rules (
  profile_id, input_key, label, direction, obligation, operation_group,
  pa_transactions_per_item, reason, source_excerpt, confidence, status,
  manually_edited, approved_by, approved_at
)
SELECT
  p.profile_id, v.input_key, v.label, v.direction, v.obligation, v.operation_group,
  v.mult, v.reason, v.excerpt, 'high', 'approved', true, a.id, NOW()
FROM profile p, admin a, (VALUES
  ('issued_b2b_domestic',
   'B2B invoice to a French customer (annual count of invoices)',
   'Issued', 'E-invoicing', 'Domestic B2B', 2::numeric,
   'France2.xlsx: Domestic issued; 2 PA tx/invoice (Flux 1 & 2). Example: 1,000→2,000.',
   'Transactions in France2.xlsx - B2B Domestic Issued'),
  
  ('received_domestic_supplier',
   'Invoice from French supplier (annual count)',
   'Received', 'E-invoicing', 'Incoming domestic e-invoicing', 1::numeric,
   'France2.xlsx: Domestic received; 1 PA tx/invoice. Example: 500→500.',
   'Transactions in France2.xlsx - B2B Domestic Received'),
  
  ('issued_b2b_foreign_er',
   'B2B invoice to foreign customer — e-reporting (annual count)',
   'Issued', 'E-reporting', 'International B2B', 2::numeric,
   'France2.xlsx: International issued; 2 PA tx/invoice. Example: 2,000→2,000.',
   'Transactions in France2.xlsx - B2B International Issued'),
  
  ('received_foreign_supplier_er',
   'Invoice from foreign supplier — e-reporting (annual count)',
   'Received', 'E-reporting', 'International purchase e-reporting', 1::numeric,
   'France2.xlsx: International received; 1 PA tx/invoice. Example: 100→100.',
   'Transactions in France2.xlsx - B2B International Received'),
  
  ('daily_report_issued_international_b2b_b2c',
   'Daily reporting: issued B2B intl (Flux 10.1) + B2C (Flux 10.3) — annual days',
   'Issued', 'E-reporting', 'Daily e-reporting', 1::numeric,
   'France2.xlsx: 1 PA tx/day. Example: 31 days→31.',
   'Transactions in France2.xlsx - Daily issued'),
  
  ('daily_report_received_international',
   'Daily reporting: received international (Flux 10.1) — annual days',
   'Received', 'E-reporting', 'Daily e-reporting', 1::numeric,
   'France2.xlsx: 1 PA tx/day. Example: 31 days→31.',
   'Transactions in France2.xlsx - Daily received'),
  
  ('daily_report_issued_payments_international',
   'Daily reporting: issued B2B intl payments (Flux 10.2) — annual days',
   'Issued', 'Payment e-reporting', 'Daily payment e-reporting', 1::numeric,
   'France2.xlsx: 1 PA tx/day. Example: 31 days→31.',
   'Transactions in France2.xlsx - Daily payments intl'),
  
  ('daily_report_issued_payments_b2c_tva',
   'Daily reporting: B2C payments VAT on collection (Flux 10.4) — annual days',
   'Issued', 'Payment e-reporting', 'B2C payment e-reporting', 1::numeric,
   'France2.xlsx: 1 PA tx/day. Example: 31 days→31.',
   'Transactions in France2.xlsx - Daily payments B2C')
) AS v(input_key, label, direction, obligation, operation_group, mult, reason, excerpt);

-- ─── 7. Plans ───────────────────────────────────────────────────────────────
WITH profile AS (
  SELECT cp.id AS profile_id
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0'
),
admin AS (
  SELECT id FROM users_profile
  WHERE role = 'admin' AND active = true
  ORDER BY created_at LIMIT 1
)
INSERT INTO plans (
  profile_id, plan_name, included_pa_transactions, annual_fee,
  extra_transaction_cost, status, confidence, source_excerpt,
  approved_by, approved_at
)
SELECT
  p.profile_id, v.plan_name, v.included, v.fee, v.extra,
  'approved', 'high', 'France B2Brouter tariff (v1.0 pricing).', a.id, NOW()
FROM profile p, admin a, (VALUES
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

-- ─── 8. Assumptions ─────────────────────────────────────────────────────────
WITH profile AS (
  SELECT cp.id AS profile_id
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0'
)
INSERT INTO assumptions (profile_id, key, value, reason, status)
SELECT p.profile_id, v.akey, v.avalue, v.areason, 'approved'
FROM profile p, (VALUES
  ('fr_mandate_domestic_issued_deadline',
   '01/09/2026 (Large) or 01/09/2027 (Rest)',
   'France2.xlsx - B2B Domestic Issued deadline.'),
  ('fr_mandate_domestic_received_deadline',
   '01/09/2026 (all companies)',
   'France2.xlsx - B2B Domestic Received deadline.'),
  ('fr_mandate_international_issued_deadline',
   '01/09/2026 (Large) or 01/09/2027 (Rest)',
   'France2.xlsx - B2B International Issued deadline.'),
  ('fr_mandate_international_received_deadline',
   '01/09/2027 (all companies)',
   'France2.xlsx - B2B International Received deadline.'),
  ('example_domestic_issued', '1,000→2,000 PA tx', 'Example: 2x multiplier'),
  ('example_domestic_received', '500→500 PA tx', 'Example: 1x multiplier'),
  ('example_international_issued', '2,000→2,000 PA tx', 'Example: 2x multiplier'),
  ('example_international_received', '100→100 PA tx', 'Example: 1x multiplier'),
  ('example_daily_reporting', '31 days per type', 'Example: Flux 10.1-10.4'),
  ('example_total', '4,693 PA transactions', 'Total from France2.xlsx calculation')
) AS v(akey, avalue, areason);

COMMIT;

-- ─── Verification ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_profile_id uuid;
  v_rules int;
  v_plans int;
  v_assumptions int;
  v_old_profiles int;
BEGIN
  -- Get v2.0 profile
  SELECT cp.id INTO v_profile_id
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter' AND cp.version = 'v2.0';
  
  -- Count inserted records
  SELECT COUNT(*) INTO v_rules FROM transaction_rules WHERE profile_id = v_profile_id;
  SELECT COUNT(*) INTO v_plans FROM plans WHERE profile_id = v_profile_id;
  SELECT COUNT(*) INTO v_assumptions FROM assumptions WHERE profile_id = v_profile_id;
  
  -- Count inactive old profiles
  SELECT COUNT(*) INTO v_old_profiles
  FROM calculation_profiles cp
  JOIN countries c ON c.id = cp.country_id
  JOIN providers p ON p.id = cp.provider_id
  WHERE c.code = 'FR' AND p.name = 'B2Brouter'
    AND cp.version != 'v2.0'
    AND cp.status = 'archived';
  
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  RAISE NOTICE '✓ Seed complete for France × B2Brouter v2.0';
  RAISE NOTICE '  Profile ID: %', v_profile_id;
  RAISE NOTICE '  Transaction rules: %', v_rules;
  RAISE NOTICE '  Plans: %', v_plans;
  RAISE NOTICE '  Assumptions: %', v_assumptions;
  RAISE NOTICE '  Old profiles archived: %', v_old_profiles;
  RAISE NOTICE '═══════════════════════════════════════════════════════';
  
  IF v_rules < 8 OR v_plans < 9 OR v_assumptions < 10 THEN
    RAISE WARNING 'Expected 8 rules, 9 plans, 10 assumptions. Got %, %, %', v_rules, v_plans, v_assumptions;
  END IF;
END $$;
