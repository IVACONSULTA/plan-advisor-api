-- =============================================================================
-- Map Supabase `public.profiles`-style users into Railway `users_profile`
-- =============================================================================
-- Prefer automating from Auth: set SUPABASE_SERVICE_ROLE_KEY in .env and run:
--   npm run db:sync-users
-- See README §4 and scripts/sync-supabase-auth-users-to-users-profile.js.
--
-- Before running manually: set each email to the **exact** address shown in Supabase
-- Dashboard → Authentication → Users for that user id (or sign-in will still
-- work on id match, but lists and admin tooling expect correct email).
--
-- Optional: link `client` users to a company:
--   UPDATE users_profile SET company_id = '<company-uuid>' WHERE id = '...';
--
-- Idempotent: re-run safely with ON CONFLICT (id) DO UPDATE.
-- =============================================================================

INSERT INTO users_profile (id, email, full_name, role, company_id, active)
VALUES
  (
    '0360cc05-1bfc-4269-9c7d-160e8f517abb',
    'internal-user@REPLACE-WITH-SUPABASE-EMAIL.com',
    'testinternaluser',
    'internal',
    NULL,
    TRUE
  ),
  (
    '7682bc0c-d561-43bd-9f7e-577b5c94e1d7',
    'admin@REPLACE-WITH-SUPABASE-EMAIL.com',
    'nexdevconsulting',
    'admin',
    NULL,
    TRUE
  ),
  (
    'daa9abd2-22a6-4109-8452-766cd80ec347',
    'client@REPLACE-WITH-SUPABASE-EMAIL.com',
    'manuelalonsoper',
    'client',
    NULL,
    TRUE
  ),
  (
    '18a1b83c-99fe-41cf-a7bf-dc34a9df3c37',
    'edercruz@ivaconsulta.com',
    'edercruz',
    'client',
    NULL,
    TRUE
  )
ON CONFLICT (id) DO UPDATE SET
  email     = EXCLUDED.email,
  full_name = EXCLUDED.full_name,
  role      = EXCLUDED.role,
  company_id = COALESCE(EXCLUDED.company_id, users_profile.company_id),
  active    = EXCLUDED.active;
