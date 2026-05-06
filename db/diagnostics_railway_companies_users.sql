-- =============================================================================
-- Diagnostics — Railway PostgreSQL only (not Supabase)
-- =============================================================================
-- Run against the SAME database as your API’s DATABASE_URL.
-- If counts are 0, the seed did not commit here, or you’re on the wrong DB.
-- =============================================================================

SELECT current_database() AS db, current_schema() AS schema, now() AS server_time;

SELECT COUNT(*) AS companies_total FROM companies;
SELECT id, name, type, created_at FROM companies ORDER BY name;

SELECT COUNT(*) AS users_profile_total FROM users_profile;
SELECT id, email, full_name, role, company_id, active, created_at
FROM users_profile
ORDER BY email;

-- Emails from seed — if rows appear here with DIFFERENT ids, fix or delete those
-- rows before re-running the users insert (unique email blocks new ids).
SELECT id, email FROM users_profile
WHERE email IN (
  'testinternaluser@gmail.com',
  'nexdevconsulting@outlook.com',
  'manuelalonsoper@gmail.com'
)
ORDER BY email;

-- Expected seed IDs (should appear after successful seed)
SELECT 'missing_company_iva' AS check_name
WHERE NOT EXISTS (
  SELECT 1 FROM companies WHERE id = 'a1110001-0000-4000-8000-000000000001'
)
UNION ALL
SELECT 'missing_company_test'
WHERE NOT EXISTS (
  SELECT 1 FROM companies WHERE id = 'a1110002-0000-4000-8000-000000000002'
)
UNION ALL
SELECT 'missing_user_0360'
WHERE NOT EXISTS (
  SELECT 1 FROM users_profile WHERE id = '0360cc05-1bfc-4269-9c7d-160e8f517abb'
)
UNION ALL
SELECT 'missing_user_7682'
WHERE NOT EXISTS (
  SELECT 1 FROM users_profile WHERE id = '7682bc0c-d561-43bd-9f7e-577b5c94e1d7'
)
UNION ALL
SELECT 'missing_user_daa9'
WHERE NOT EXISTS (
  SELECT 1 FROM users_profile WHERE id = 'daa9abd2-22a6-4109-8452-766cd80ec347'
);

-- If this returns NO rows, all five checks passed.
