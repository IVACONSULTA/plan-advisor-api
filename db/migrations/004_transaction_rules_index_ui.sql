-- Migration 004: add index_ui to transaction_rules
-- index_ui controls the display order of rules in the calculator UI.
-- NULL means unset; the API sorts by index_ui NULLS LAST, then label ASC.
ALTER TABLE transaction_rules
  ADD COLUMN IF NOT EXISTS index_ui INTEGER;
