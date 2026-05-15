# Railway Database Migration Guide — PA Plan Advisor API

How to export and import PostgreSQL databases between Railway environments (e.g., production → staging → local).

---

## Quick Reference

| Task | Command |
|------|---------|
| Export full database | `pg_dump -Fc --no-acl --no-owner "$DATABASE_URL" -f backup.dump` |
| Export as plain SQL | `pg_dump --no-acl --no-owner "$DATABASE_URL" > backup.sql` |
| Import custom format | `pg_restore --clean --no-acl --no-owner -d "$DATABASE_URL" backup.dump` |
| Import plain SQL | `psql "$DATABASE_URL" < backup.sql` |

---

## Export Options

### 1. Full Export (Custom Format — Compressed)

Best for complete backups. Uses PostgreSQL's custom format (compressed, faster).

```bash
pg_dump -Fc --no-acl --no-owner \
  "$DATABASE_URL" \
  -f planadvisor_backup.dump
```

### 2. Plain SQL Export (Human Readable)

Best for version control or manual editing. Larger file size.

```bash
pg_dump --no-acl --no-owner \
  "$DATABASE_URL" \
  > planadvisor_backup.sql
```

### 3. Schema Only (Structure, No Data)

Useful for setting up fresh environments.

```bash
pg_dump --schema-only --no-acl --no-owner \
  "$DATABASE_URL" \
  > schema.sql
```

### 4. Data Only (No Structure)

Useful when schema already exists and you only need to migrate records.

```bash
pg_dump --data-only --no-acl --no-owner \
  "$DATABASE_URL" \
  > data.sql
```

### 5. Specific Tables Only

```bash
pg_dump --no-acl --no-owner \
  -t transaction_rules -t plans -t scenarios \
  "$DATABASE_URL" \
  > tables_backup.sql
```

---

## Import Options

### 1. Import Custom Format Dump

```bash
pg_restore --clean --no-acl --no-owner \
  -d "$DATABASE_URL" \
  planadvisor_backup.dump
```

**Flags explained:**
- `--clean` — Drop existing objects before recreating (use with caution)
- `--if-exists` — Add this to avoid errors if objects don't exist
- `--no-owner` — Skip ownership settings (Railway handles this)
- `--no-acl` — Skip privilege settings

### 2. Import Plain SQL

```bash
psql "$DATABASE_URL" < planadvisor_backup.sql
```

### 3. Import Schema + Data Separately

```bash
# First import structure
psql "$DATABASE_URL" < schema.sql

# Then import data
psql "$DATABASE_URL" < data.sql
```

---

## Environment-to-Environment Migration

### Example: Production → Staging

```bash
# 1. Get DATABASE_URL from production environment
#    (Railway Dashboard → Postgres service → Connect tab)

# 2. Export from production
pg_dump -Fc --no-acl --no-owner \
  "postgresql://postgres:PASS@PROD_HOST:5432/railway" \
  -f prod_to_staging.dump

# 3. Get DATABASE_URL from staging environment

# 4. Import to staging (DESTRUCTIVE — drops existing data)
pg_restore --clean --if-exists --no-acl --no-owner \
  -d "postgresql://postgres:PASS@STAGING_HOST:5432/railway" \
  prod_to_staging.dump
```

### Using Railway CLI

```bash
# Switch to production and connect
railway environment use production
railway connect postgres

# In another terminal, export
pg_dump -Fc --no-acl --no-owner \
  $(railway variables get DATABASE_URL) \
  -f backup.dump

# Switch to staging and import
railway environment use staging
pg_restore --clean --no-acl --no-owner \
  -d $(railway variables get DATABASE_URL) \
  backup.dump
```

---

## Railway ↔ Local Development

### Export from Railway to Local

```bash
# Export from Railway
pg_dump --no-acl --no-owner \
  "$RAILWAY_DATABASE_URL" \
  > local_dev_seed.sql

# Import to local Docker Postgres
psql "postgresql://postgres:postgres@localhost:5432/planadvisor" \
  < local_dev_seed.sql
```

### Export from Local to Railway

```bash
# Export local database
pg_dump --no-acl --no-owner \
  "postgresql://postgres:postgres@localhost:5432/planadvisor" \
  > local_backup.sql

# Import to Railway (use with caution on production!)
psql "$RAILWAY_DATABASE_URL" < local_backup.sql
```

---

## Project Helper Script

Use the project's existing script for running SQL files:

```bash
# Run any SQL file against the configured database
node scripts/run-psql-file.js db/seed_france_b2brouter_v2.sql
```

For migrations, ensure the files are applied in order:

```bash
for f in db/migrations/*.sql; do
  echo "Running $f..."
  node scripts/run-psql-file.js "$f"
done
```

---

## Troubleshooting

### Connection Issues

```bash
# Test connection
psql "$DATABASE_URL" -c "SELECT 1;"

# Check PostgreSQL version
psql "$DATABASE_URL" -c "SELECT version();"
```

### Permission Errors

Always use `--no-owner --no-acl` flags. Railway manages permissions internally.

### Large Database Timeouts

For large databases, add `--verbose` and increase statement timeout:

```bash
PGOPTIONS="-c statement_timeout=0" \
  pg_dump -Fc --no-acl --no-owner \
  "$DATABASE_URL" \
  -f large_backup.dump
```

### Encoding Issues

Force UTF-8 encoding:

```bash
pg_dump --encoding=UTF8 --no-acl --no-owner \
  "$DATABASE_URL" \
  > backup.sql
```

---

## Security Notes

- **Never commit database dumps to Git** — add `*.dump`, `*.sql` to `.gitignore`
- **Rotate credentials after migration** — generate new database passwords in Railway if needed
- **Use environment variables** — never hardcode database URLs in scripts

---

## Related Documentation

- [Railway Postgres Documentation](https://docs.railway.com/databases/postgresql)
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [PostgreSQL pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html)
