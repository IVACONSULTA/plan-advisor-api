-- Migration: Make country_id and provider_id nullable in documents table
-- Reason: During wizard draft flow, documents are uploaded before profile is created
-- and country/provider IDs may not be available yet.

ALTER TABLE documents
  ALTER COLUMN country_id DROP NOT NULL,
  ALTER COLUMN provider_id DROP NOT NULL;

-- Add a check constraint to ensure that if profile_id is set, country_id and provider_id should match
-- (This is informational and can be validated at application level)
COMMENT ON COLUMN documents.country_id IS 'Country ID - nullable during draft uploads, should be set when profile is created';
COMMENT ON COLUMN documents.provider_id IS 'Provider ID - nullable during draft uploads, should be set when profile is created';
