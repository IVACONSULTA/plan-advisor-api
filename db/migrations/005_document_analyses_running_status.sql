-- Migration 005: add 'running' status to document_analyses
-- Enables async document analysis: API creates a 'running' row up front,
-- kicks off the agent call in the background, and updates the row to
-- 'completed' or 'failed' when finished. Clients poll the status endpoint
-- to know when results are ready.
ALTER TABLE document_analyses
  DROP CONSTRAINT IF EXISTS document_analyses_status_check;

ALTER TABLE document_analyses
  ADD CONSTRAINT document_analyses_status_check
  CHECK (status IN ('running', 'completed', 'failed', 'pending_review'));
