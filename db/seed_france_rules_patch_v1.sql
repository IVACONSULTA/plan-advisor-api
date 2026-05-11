-- =============================================================================
-- Patch: France × B2Brouter — transaction_rules update + new inserts
-- Profile ID: f90e025e-b024-4b9e-8a91-804f3063fb2c
--
-- Sources:
--   • "Transactions in France2.xlsx - France.pdf"  ← authoritative (latest)
--   • "Transactions in France.xlsx - France.pdf"   ← initial reference
--   • "Proyecto Agente Calculadora Pa Einvoicing Ereporting.pdf" ← functional spec
--
-- What this script does
-- ─────────────────────
-- PART 1 — UPDATE 9 existing rules:
--   • Refreshes labels, reasons and source_excerpts to reference France2.xlsx.
--   • CRITICAL: issued_b2b_foreign_er pa_transactions_per_item  2 → 1
--     (France2.xlsx: 2,000 international issued invoices → 2,000 PA tx,
--      only "Envío al cliente"; no DGFiP fiscal-report flux for cross-border.)
--   • Renames received_foreign_daily_report_days → daily_report_received_international
--     to align with the Flux 10.x naming used in France2.xlsx.
--   • Marks the orphan issued_einvoicing stub as 'rejected'.
--
-- PART 2 — INSERT 3 new rules (all from France2.xlsx daily-report section):
--   • daily_report_issued_international_b2b_b2c  (Flux 10.1 + Flux 10.3)
--   • daily_report_issued_payments_international  (Flux 10.2)
--   • daily_report_issued_payments_b2c_tva        (Flux 10.4)
--
-- Expected result after run
-- ─────────────────────────
--   Total rules   : 12  (9 existing + 3 new)
--   Approved      : 11
--   Rejected      : 1   (issued_einvoicing stub)
--
-- France2.xlsx example totals (validation)
--   2,000 (dom. issued) + 500 (dom. rec.) + 2,000 (intl. issued) +
--   100 (intl. rec.) + 31 (daily issued) + 31 (daily rec.) + 31 (daily pmt)
--   = 4,693 PA transactions
--
-- Safe to re-run — UPDATEs are idempotent; INSERTs are guarded by NOT EXISTS.
-- =============================================================================

BEGIN;

-- Guard: profile must exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM calculation_profiles
    WHERE id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  ) THEN
    RAISE EXCEPTION
      'Profile f90e025e-b024-4b9e-8a91-804f3063fb2c not found. '
      'Run the base seed first.';
  END IF;
  RAISE NOTICE 'Profile found — proceeding with patch.';
END $$;


-- =============================================================================
-- PART 1 — UPDATE existing rules
-- =============================================================================

-- ── 1a. issued_b2b_domestic ──────────────────────────────────────────────────
-- France2.xlsx: 1,000 invoices → 2,000 PA tx (Flux 1 & 2). Multiplier = 2. ✓
UPDATE transaction_rules
SET
  label           = 'B2B invoice to a French customer — domestic e-invoicing (annual invoice count)',
  reason          = 'France2.xlsx: Domestic B2B issued; 2 PA tx/invoice — Flux 1 (send to client) + Flux 2 (report to DGFiP). Example: 1,000 invoices → 2,000 PA tx.',
  source_excerpt  = 'Transactions in France2.xlsx — B2B Domestic Issued: 1,000 invoices → 2,000 transactions (Flux 1 & 2).',
  confidence      = 'high',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'issued_b2b_domestic';

-- ── 1b. issued_credit_note_domestic ──────────────────────────────────────────
-- Credit notes follow the same domestic Flux 1 + 2 path. Multiplier = 2. ✓
UPDATE transaction_rules
SET
  label           = 'Credit note / corrective invoice to a French customer — domestic e-invoicing (annual count)',
  reason          = 'France2.xlsx: Credit notes use same domestic e-invoicing path as B2B issued invoices; 2 PA tx per document (Flux 1 + Flux 2).',
  source_excerpt  = 'Transactions in France2.xlsx — Domestic B2B Issued. Credit notes treated identically to standard invoices under domestic e-invoicing.',
  confidence      = 'high',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'issued_credit_note_domestic';

-- ── 1c. issued_b2b_foreign_er ─────────────────────────────────────────────────
-- *** CRITICAL CORRECTION: 2 → 1 PA tx/invoice ***
-- France2.xlsx: 2,000 invoices → 2,000 PA tx ("Envío al cliente" only).
-- International/cross-border B2B is e-reporting (not full e-invoicing):
-- only 1 flux required (send to client), no DGFiP fiscal-report submission.
UPDATE transaction_rules
SET
  pa_transactions_per_item = 1,
  label           = 'B2B invoice to a foreign customer — international e-reporting (annual invoice count)',
  reason          = 'France2.xlsx: International B2B issued; 1 PA tx/invoice — only Flux "Envío al cliente". Cross-border invoices require e-reporting only (no DGFiP fiscal report); 1 transmission flux. Example: 2,000 invoices → 2,000 PA tx.',
  source_excerpt  = 'Transactions in France2.xlsx — B2B International Issued: 2,000 invoices → 2,000 transactions (Envío al cliente). Previous value of 2 was incorrect for international e-reporting.',
  confidence      = 'high',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'issued_b2b_foreign_er';

-- ── 1d. issued_b2c_consumer_er ───────────────────────────────────────────────
-- France2.xlsx shows B2C is reported daily via Flux 10.3 (see new rule
-- daily_report_issued_international_b2b_b2c). This per-invoice rule is kept
-- for companies that choose to report B2C invoice-by-invoice (if permitted).
UPDATE transaction_rules
SET
  label           = 'B2C invoice to a French consumer — per-invoice e-reporting (annual count, when applicable)',
  reason          = 'France2.xlsx: B2C invoices are normally reported daily (Flux 10.3, see daily_report_issued_international_b2b_b2c). This per-invoice rule applies only when the company reports B2C invoice-by-invoice instead of via daily summary. 2 PA tx per invoice.',
  source_excerpt  = 'Transactions in France2.xlsx — B2C Issued invoices listed under Daily report (Flux 10.3). Per-invoice rule retained for non-daily reporting scenarios.',
  confidence      = 'medium',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'issued_b2c_consumer_er';

-- ── 1e. issued_payment_er ─────────────────────────────────────────────────────
-- France2.xlsx shows payment e-reporting is daily (Flux 10.2 + 10.4).
-- This per-report rule is retained for non-daily / per-report scenarios.
UPDATE transaction_rules
SET
  label           = 'Reportable payment where VAT is due on collection — per report (annual count)',
  reason          = 'France2.xlsx: Payment e-reporting is daily (Flux 10.2 + Flux 10.4, see daily_report_issued_payments_* rules). This per-report rule covers companies reporting payments individually rather than daily. 1 PA tx per report.',
  source_excerpt  = 'Transactions in France2.xlsx — Daily report of issued payments: Flux 10.2 (B2B intl) + Flux 10.4 (B2C TVA sur encaissements). Per-report variant retained for non-daily scenarios.',
  confidence      = 'medium',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'issued_payment_er';

-- ── 1f. received_domestic_supplier ───────────────────────────────────────────
-- France2.xlsx: 500 invoices → 500 PA tx (reception). Multiplier = 1. ✓
UPDATE transaction_rules
SET
  label           = 'Invoice from a French supplier — incoming domestic e-invoicing (annual invoice count)',
  reason          = 'France2.xlsx: Domestic B2B received; 1 PA tx/invoice (reception). Example: 500 invoices → 500 PA tx.',
  source_excerpt  = 'Transactions in France2.xlsx — B2B Domestic Received: 500 invoices → 500 transactions (Recepción).',
  confidence      = 'high',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'received_domestic_supplier';

-- ── 1g. received_foreign_supplier_er ─────────────────────────────────────────
-- France2.xlsx: 100 invoices → 100 PA tx (reception). Multiplier = 1. ✓
UPDATE transaction_rules
SET
  label           = 'Invoice from a foreign supplier — incoming international e-reporting (annual invoice count)',
  reason          = 'France2.xlsx: International B2B received; 1 PA tx/invoice (reception). Example: 100 invoices → 100 PA tx.',
  source_excerpt  = 'Transactions in France2.xlsx — B2B International Received: 100 invoices → 100 transactions (Recepción).',
  confidence      = 'high',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'received_foreign_supplier_er';

-- ── 1h. received_foreign_daily_report_days → daily_report_received_international
-- Rename + update to use France2.xlsx Flux 10.1 (received) naming.
UPDATE transaction_rules
SET
  input_key       = 'daily_report_received_international',
  label           = 'Daily reporting: received international invoices (Flux 10.1) — annual reporting days',
  direction       = 'Received',
  obligation      = 'E-reporting',
  operation_group = 'Daily e-reporting',
  pa_transactions_per_item = 1,
  reason          = 'France2.xlsx: 1 PA tx per day the recipient receives international invoices (Flux 10.1). Example: 31 days → 31 PA tx.',
  source_excerpt  = 'Transactions in France2.xlsx — Daily report of received transactions: International Received (Flux 10.1) — 31 days → 31 PA tx (1 tx/day).',
  confidence      = 'high',
  status          = 'approved',
  manually_edited = true,
  approved_by     = 'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  approved_at     = NOW()
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'received_foreign_daily_report_days';

-- ── 1i. issued_einvoicing (proposed stub) → rejected ─────────────────────────
-- Auto-generated stub when DOC_AGENT_URL was unset. Replaced by the specific
-- rules above (issued_b2b_domestic, issued_credit_note_domestic, etc.).
UPDATE transaction_rules
SET
  status          = 'rejected',
  reason          = 'Auto-generated fallback stub; superseded by specific rules: issued_b2b_domestic, issued_credit_note_domestic, issued_b2b_foreign_er, issued_b2c_consumer_er. See France2.xlsx.',
  manually_edited = true
WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
  AND input_key  = 'issued_einvoicing'
  AND status     = 'proposed';


-- =============================================================================
-- PART 2 — INSERT new rules (France2.xlsx daily-report section)
-- =============================================================================

-- ── 2a. daily_report_issued_international_b2b_b2c ────────────────────────────
-- France2.xlsx: Daily report of ISSUED transactions.
--   Flux 10.1 — B2B international issued invoices
--   Flux 10.3 — B2C issued invoices (reported in same daily block as Flux 10.1)
-- 1 PA tx per reporting day. Example: 31 days → 31 PA tx.
INSERT INTO transaction_rules (
  profile_id, input_key, label, direction, obligation, operation_group,
  pa_transactions_per_item, reason, source_excerpt, confidence, status,
  manually_edited, approved_by, approved_at
)
SELECT
  'f90e025e-b024-4b9e-8a91-804f3063fb2c',
  'daily_report_issued_international_b2b_b2c',
  'Daily reporting: issued B2B international (Flux 10.1) + B2C invoices (Flux 10.3) — annual reporting days',
  'Issued',
  'E-reporting',
  'Daily e-reporting',
  1,
  'France2.xlsx: 1 PA tx per day where the company sends B2B international and/or B2C invoices. Flux 10.1 (B2B intl issued) and Flux 10.3 (B2C issued) are combined in the same daily block. Example: 31 days → 31 PA tx.',
  'Transactions in France2.xlsx — Daily report of issued transactions: B2B international (Flux 10.1) + B2C (Flux 10.3) — 31 days → 31 PA tx (1 tx/day).',
  'high',
  'approved',
  true,
  'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM transaction_rules
  WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
    AND input_key  = 'daily_report_issued_international_b2b_b2c'
);

-- ── 2b. daily_report_issued_payments_international ────────────────────────────
-- France2.xlsx: Daily report of ISSUED PAYMENTS.
--   Flux 10.2 — B2B international payments
-- 1 PA tx per reporting day. Example: 31 days → 31 PA tx.
INSERT INTO transaction_rules (
  profile_id, input_key, label, direction, obligation, operation_group,
  pa_transactions_per_item, reason, source_excerpt, confidence, status,
  manually_edited, approved_by, approved_at
)
SELECT
  'f90e025e-b024-4b9e-8a91-804f3063fb2c',
  'daily_report_issued_payments_international',
  'Daily reporting: issued B2B international payments (Flux 10.2) — annual reporting days',
  'Issued',
  'Payment e-reporting',
  'Daily payment e-reporting',
  1,
  'France2.xlsx: 1 PA tx per day where the company has B2B international payments to report (Flux 10.2). Example: 31 days → 31 PA tx.',
  'Transactions in France2.xlsx — Daily report of issued payments: B2B international (Flux 10.2) — 31 days → 31 PA tx (1 tx/day).',
  'high',
  'approved',
  true,
  'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM transaction_rules
  WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
    AND input_key  = 'daily_report_issued_payments_international'
);

-- ── 2c. daily_report_issued_payments_b2c_tva ─────────────────────────────────
-- France2.xlsx: Daily report of ISSUED PAYMENTS — B2C only.
--   Flux 10.4 — B2C payments where VAT is due on collection
--               (TVA sur les encaissements). Applies when relevant.
-- 1 PA tx per reporting day. Example: 31 days → 31 PA tx.
INSERT INTO transaction_rules (
  profile_id, input_key, label, direction, obligation, operation_group,
  pa_transactions_per_item, reason, source_excerpt, confidence, status,
  manually_edited, approved_by, approved_at
)
SELECT
  'f90e025e-b024-4b9e-8a91-804f3063fb2c',
  'daily_report_issued_payments_b2c_tva',
  'Daily reporting: B2C payments with VAT on collection — TVA sur les encaissements (Flux 10.4) — annual reporting days',
  'Issued',
  'Payment e-reporting',
  'B2C payment e-reporting',
  1,
  'France2.xlsx: 1 PA tx per day for companies with B2C payments subject to VAT on collection (TVA sur les encaissements — Flux 10.4). Only applies when this regime is applicable to the company. Example: 31 days → 31 PA tx.',
  'Transactions in France2.xlsx — Daily report of issued payments: B2C payments TVA sur les encaissements (Flux 10.4) — 31 days → 31 PA tx (1 tx/day).',
  'high',
  'approved',
  true,
  'baaaaaaa-baaa-4aaa-8aaa-aaaaaaaaaaaa',
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM transaction_rules
  WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
    AND input_key  = 'daily_report_issued_payments_b2c_tva'
);

COMMIT;

-- =============================================================================
-- Verification
-- =============================================================================
DO $$
DECLARE
  v_total    int;
  v_approved int;
  v_rejected int;
  v_proposed int;
  v_rec      RECORD;
BEGIN
  SELECT COUNT(*) INTO v_total
    FROM transaction_rules WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c';
  SELECT COUNT(*) INTO v_approved
    FROM transaction_rules WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c' AND status = 'approved';
  SELECT COUNT(*) INTO v_rejected
    FROM transaction_rules WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c' AND status = 'rejected';
  SELECT COUNT(*) INTO v_proposed
    FROM transaction_rules WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c' AND status = 'proposed';

  RAISE NOTICE '';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';
  RAISE NOTICE '✓ Patch complete — France × B2Brouter transaction rules';
  RAISE NOTICE '  Profile : f90e025e-b024-4b9e-8a91-804f3063fb2c';
  RAISE NOTICE '  Total   : %   (expected 12)', v_total;
  RAISE NOTICE '  Approved: %   (expected 11)', v_approved;
  RAISE NOTICE '  Rejected: %   (expected  1 — issued_einvoicing stub)', v_rejected;
  RAISE NOTICE '  Proposed: %   (expected  0)', v_proposed;
  RAISE NOTICE '';
  RAISE NOTICE '  France2.xlsx example validation:';
  RAISE NOTICE '  2,000 (dom.issued) + 500 (dom.rec.) + 2,000 (intl.issued)';
  RAISE NOTICE '  + 100 (intl.rec.) + 31×3 (daily) = 4,693 PA tx';
  RAISE NOTICE '══════════════════════════════════════════════════════════════';

  IF v_approved < 11 THEN
    RAISE WARNING 'Expected 11 approved rules, got %. Check for missing inserts.', v_approved;
  END IF;
  IF v_proposed > 0 THEN
    RAISE WARNING '% proposed stub(s) still present — review and reject if not needed.', v_proposed;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'Approved rules summary:';
  FOR v_rec IN
    SELECT input_key, pa_transactions_per_item, direction, obligation
    FROM transaction_rules
    WHERE profile_id = 'f90e025e-b024-4b9e-8a91-804f3063fb2c'
      AND status = 'approved'
    ORDER BY direction DESC, obligation, input_key
  LOOP
    RAISE NOTICE '  %-50s  × %s  [% / %]',
      v_rec.input_key,
      v_rec.pa_transactions_per_item,
      v_rec.direction,
      v_rec.obligation;
  END LOOP;
END $$;
