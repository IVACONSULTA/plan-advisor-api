-- Users only — run AFTER seed_iva_consulta_companies.sql on the SAME Railway database.
-- RETURNING proves how many rows Postgres touched (should be 3).
--
-- If you get: duplicate key on users_profile_email_key → another row already has that email.
-- Run: SELECT id, email FROM users_profile WHERE email IN (
--   'testinternaluser@gmail.com', 'nexdevconsulting@outlook.com', 'manuelalonsoper@gmail.com'
-- );

INSERT INTO users_profile (id, email, full_name, role, company_id, active)
VALUES
  (
    '0360cc05-1bfc-4269-9c7d-160e8f517abb',
    'testinternaluser@gmail.com',
    'testinternaluser',
    'internal',
    'a1110001-0000-4000-8000-000000000001',
    TRUE
  ),
  (
    '7682bc0c-d561-43bd-9f7e-577b5c94e1d7',
    'nexdevconsulting@outlook.com',
    'nexdevconsulting',
    'admin',
    'a1110001-0000-4000-8000-000000000001',
    TRUE
  ),
  (
    'daa9abd2-22a6-4109-8452-766cd80ec347',
    'manuelalonsoper@gmail.com',
    'manuelalonsoper',
    'client',
    'a1110002-0000-4000-8000-000000000002',
    TRUE
  )
ON CONFLICT (id) DO UPDATE SET
  email      = EXCLUDED.email,
  full_name  = EXCLUDED.full_name,
  role       = EXCLUDED.role,
  company_id = EXCLUDED.company_id,
  active     = EXCLUDED.active
RETURNING id, email, role, company_id;
