-- Migration: document_staging (wizard draft uploads before activate)
-- Run once against the PostgreSQL database linked to PlanAdvisorAPI on Railway.
--
-- Railway: open PostgreSQL service → Connect → use Query / psql, paste this file,
-- or from your machine:
--   psql "$DATABASE_URL" -f db/migrations/001_document_staging.sql
--
-- Resolves: Postgres error 42P01 — relation "document_staging" does not exist

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS document_staging (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_slug     TEXT NOT NULL,
  filename         TEXT NOT NULL,
  storage_path     TEXT NOT NULL,
  document_type    TEXT NOT NULL
                     CHECK (document_type IN (
                       'provider_pricing','transaction_guide','country_legal',
                       'contract','commercial_confirmation','other'
                     )),
  description      TEXT,
  copyright_status TEXT NOT NULL DEFAULT 'pending'
                     CHECK (copyright_status IN ('pending','clear','restricted','blocked')),
  uploaded_by      UUID NOT NULL REFERENCES users_profile(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_staging_slug ON document_staging(profile_slug);
