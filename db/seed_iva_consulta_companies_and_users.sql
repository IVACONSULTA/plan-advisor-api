-- =============================================================================
-- One-file seed — NO outer transaction (each statement commits on its own in
-- clients with autocommit, e.g. many HTTP SQL UIs). Avoids losing companies when
-- a later statement fails inside a rolled-back transaction.
-- =============================================================================
-- Run in order top-to-bottom. After users insert you MUST see 3 rows from RETURNING.
-- If RETURNING is empty or errors, read the message (often duplicate email).
-- =============================================================================

INSERT INTO companies (id, name, type)
VALUES
  ('a1110001-0000-4000-8000-000000000001', 'Iva Consulta', 'internal'),
  ('a1110002-0000-4000-8000-000000000002', 'Test Company', 'client')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type;

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

SELECT id, name, type FROM companies
WHERE id IN (
  'a1110001-0000-4000-8000-000000000001',
  'a1110002-0000-4000-8000-000000000002'
)
ORDER BY name;

SELECT id, email, full_name, role, company_id, active FROM users_profile
WHERE id IN (
  '0360cc05-1bfc-4269-9c7d-160e8f517abb',
  '7682bc0c-d561-43bd-9f7e-577b5c94e1d7',
  'daa9abd2-22a6-4109-8452-766cd80ec347'
)
ORDER BY email;
