-- Migration 006: add UNIQUE (profile_id, key) to assumptions
-- Enables ON CONFLICT DO NOTHING on re-runs so re-analysing a profile does not
-- duplicate assumption rows.
ALTER TABLE assumptions
  ADD CONSTRAINT assumptions_profile_id_key_unique UNIQUE (profile_id, key);
