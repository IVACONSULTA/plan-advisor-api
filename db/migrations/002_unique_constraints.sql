-- Migration: Add unique constraint on providers.name
-- Required for ON CONFLICT clause in wizard auto-create flow
-- Countries.code should already be UNIQUE per schema.sql

-- Run once on Railway Postgres:
--   psql "$DATABASE_URL" -f db/migrations/002_unique_constraints.sql

-- Add unique constraint on providers.name (idempotent)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'providers'::regclass 
        AND conname = 'providers_name_key'
    ) THEN
        ALTER TABLE providers ADD CONSTRAINT providers_name_key UNIQUE (name);
    END IF;
END $$;

-- Also ensure countries.code is unique (idempotent - should already exist)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'countries'::regclass 
        AND conname = 'countries_code_key'
    ) THEN
        ALTER TABLE countries ADD CONSTRAINT countries_code_key UNIQUE (code);
    END IF;
END $$;


