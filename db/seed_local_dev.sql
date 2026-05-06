-- =============================================================================
-- Full local seed — same data the repo defines for production-style environments
-- =============================================================================
-- Prerequisites: `db/schema.sql` already applied (`npm run db:schema`).
--
-- Run from the project root:
--   psql "$DATABASE_URL" -f db/seed_local_dev.sql
--
-- Or:  npm run db:seed
--
-- This file chains:
--   1. Companies + users_profile (Iva Consulta / Test Company + three users)
--   2. France × B2Brouter calculator v1.0 (needs an active admin in users_profile)
--
-- Idempotent / safe to re-run: seeds use ON CONFLICT or replace scoped rows.
--
-- If Railway has extra rows not in git, clone that database instead:
--   pg_dump "$DATABASE_PUBLIC_URL" --data-only --no-owner | psql "$DATABASE_URL"
-- =============================================================================

\echo ''
\echo '>>> db/seed_iva_consulta_companies_and_users.sql'
\ir seed_iva_consulta_companies_and_users.sql

\echo ''
\echo '>>> db/seed_france_b2brouter_v1.sql'
\ir seed_france_b2brouter_v1.sql

\echo ''
\echo '>>> db/seed_local_dev.sql finished.'
