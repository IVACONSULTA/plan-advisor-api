-- Companies only — run first on Railway Postgres (auto-commits as one statement).
INSERT INTO companies (id, name, type)
VALUES
  ('a1110001-0000-4000-8000-000000000001', 'Iva Consulta', 'internal'),
  ('a1110002-0000-4000-8000-000000000002', 'Test Company', 'client')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type;

SELECT id, name, type FROM companies
WHERE id IN (
  'a1110001-0000-4000-8000-000000000001',
  'a1110002-0000-4000-8000-000000000002'
)
ORDER BY name;
