# Railway Database Migration Guide — PA Plan Advisor API

How to export and import PostgreSQL databases between Railway environments (e.g., production → staging → local).

---

## Quick Reference

| Task                        | Command                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Export full database        | `pg_dump -Fc --no-acl --no-owner "$DATABASE_URL" -f backup.dump`                                                     |
| Export as plain SQL         | `pg_dump --no-acl --no-owner "$DATABASE_URL" > backup.sql`                                                           |
| Import custom format        | `pg_restore --clean --no-acl --no-owner -d "$DATABASE_URL" backup.dump`                                              |
| Import plain SQL            | `psql "$DATABASE_URL" < backup.sql`                                                                                  |
| **Railway: Get Dev DB URL** | `railway env link dev && railway variables`                                                                          |
| **Railway: Dev → Prod**     | `railway env link dev && railway run -- pg_dump ... && railway env link production && railway run -- pg_restore ...` |

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

### Using Railway CLI (Recommended for Environment-to-Environment)

The Railway CLI is the most reliable way to migrate data between Railway environments (Dev → Prod, Prod → Staging, etc.) because it automatically handles authentication and environment context.

#### Prerequisites

```bash
# Ensure you're logged in to Railway CLI
railway login

# Verify your project is linked
railway status

# List available environments
railway env list

# Link to a specific environment (this selects which environment to use)
railway env link Dev      # or Prod, Staging, etc.
```

**Note:** Use `railway env link <ENV>` to select which environment to operate in, not `railway env use`.

#### Method 1: Using `railway run` (Most Reliable - v4.x)

This is the recommended approach for Railway CLI v4.x. The `run` command automatically injects environment variables:

**Step 1: Export from Dev environment**

```bash
# Switch to dev environment
railway env link Dev

# Verify you're on the correct environment
railway status

# Export using railway run (DATABASE_URL is auto-injected)
railway run -- pg_dump -Fc --no-acl --no-owner "$DATABASE_URL" -f dev_to_prod_backup.dump

# Verify the dump was created
ls -lh dev_to_prod_backup.dump
```

**Step 2: Import to Production**

```bash
# Switch to production environment
railway env link Prod

# Verify environment (CRITICAL - this prevents accidents)
railway status

# Restore to production using railway run
# WARNING: This will DROP and RECREATE all tables. Use with caution!
railway run -- pg_restore --clean --if-exists --no-acl --no-owner -d "$DATABASE_URL" dev_to_prod_backup.dump
```

**Step 3: Verify the migration**

```bash
# Check that tables exist and have data
railway run -- psql "$DATABASE_URL" -c "\dt"

# Count rows in key tables to verify
railway run -- psql "$DATABASE_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
```

#### Method 2: Using Public URL (For External Connections)

If you need to connect from your local machine without `railway run`, use the public URL:

**Step 1: Get the DATABASE_PUBLIC_URL**

```bash
# View all variables to find the public URL
railway env link dev
railway variables

# Or get it from Railway Dashboard:
# Dashboard → Dev Environment → Postgres Service → Connect tab → Copy "Public URL"
```

**Step 2: Export using the public URL**

```bash
# Use the DATABASE_PUBLIC_URL directly
export DEV_URL="postgresql://postgres:PASSWORD@HOST:PORT/railway"
pg_dump -Fc --no-acl --no-owner "$DEV_URL" -f dev_to_prod_backup.dump
```

**Step 3: Import to Production**

```bash
# Get Production public URL from Dashboard or CLI
export PROD_URL="postgresql://postgres:PASSWORD@HOST:PORT/railway"

# Restore to production
pg_restore --clean --if-exists --no-acl --no-owner -d "$PROD_URL" dev_to_prod_backup.dump
```

#### Method 3: Environment-to-Environment Direct Transfer

For transferring directly between Railway environments without saving to a local file:

```bash
#!/bin/bash
# save as: sync-railway-envs.sh

echo "=== Railway Dev → Prod Sync ==="

# Export from Dev and pipe directly to Prod
railway env link dev
echo "Exporting from Dev..."
railway run -- pg_dump -Fc --no-acl --no-owner "$DATABASE_URL" > /tmp/dev_backup.dump

# Switch to prod and import
railway env link production
echo "Importing to Production..."
railway run -- pg_restore --clean --if-exists --no-acl --no-owner -d "$DATABASE_URL" /tmp/dev_backup.dump

# Cleanup
rm /tmp/dev_backup.dump
echo "✓ Sync complete!"
```

#### Alternative: Schema Only + Data Only (For Large Databases)

```bash
# Export schema only from Dev
railway env link dev
railway run -- pg_dump --schema-only --no-acl --no-owner "$DATABASE_URL" > schema.sql

# Export data only from Dev
railway run -- pg_dump --data-only --no-acl --no-owner "$DATABASE_URL" > data.sql

# Apply to Production (first schema, then data)
railway env link production
railway run -- psql "$DATABASE_URL" < schema.sql
railway run -- psql "$DATABASE_URL" < data.sql
```

#### Railway CLI Variable Commands Reference

```bash
# List all variables (shows both names and values)
railway variables

# Get a specific variable (v4.x syntax - outputs with formatting)
railway variables DATABASE_URL

# View variables without switching environments
railway variables --environment=dev
railway variables --environment=production
```

**Note:** In Railway CLI v4.x, use `railway run` for database operations as it automatically handles authentication and injects the correct `DATABASE_URL`. The public URL (`DATABASE_PUBLIC_URL`) is for external connections from your local machine.

---

## Common Railway CLI Workflows

### Workflow 1: Complete Sync from Dev to Prod

When you need to make Production exactly match Development:

```bash
#!/bin/bash
# save as: sync-dev-to-prod.sh
# WARNING: This replaces ALL data in production with dev data

echo "=== Railway Dev → Prod Sync ==="

echo "Step 1: Exporting from Dev..."
railway env link dev
railway run -- pg_dump -Fc --no-acl --no-owner "$DATABASE_URL" -f /tmp/dev_backup.dump

echo "Step 2: Importing to Production..."
railway env link production
railway run -- pg_restore --clean --if-exists --no-acl --no-owner -d "$DATABASE_URL" /tmp/dev_backup.dump

echo "Step 3: Verifying..."
railway run -- psql "$DATABASE_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"

echo "✓ Sync complete!"
rm /tmp/dev_backup.dump
```

### Workflow 2: Refresh Local from Railway

When your local database is stale and needs to match Railway Dev (using public URL):

```bash
#!/bin/bash
# save as: refresh-local.sh

echo "=== Refreshing Local Database from Railway Dev ==="

# Get the public URL from Railway (or copy from Dashboard)
railway env link dev
echo "Exporting from Railway Dev..."

# Use railway run to export, or use the public URL directly
railway run -- pg_dump --no-acl --no-owner "$DATABASE_URL" > /tmp/railway_sync.sql

# Reset local database
echo "Resetting local database..."
docker compose down -v
docker compose up -d postgres
sleep 5  # Wait for Postgres to start

# Import to local
echo "Importing to local..."
psql "postgresql://postgres:postgres@localhost:5432/planadvisor" < /tmp/railway_sync.sql

# Cleanup
rm /tmp/railway_sync.sql
echo "✓ Local database refreshed!"
```

### Workflow 3: Compare Row Counts Between Environments

Verify that environments are in sync:

```bash
#!/bin/bash
# save as: compare-envs.sh

echo "=== Comparing Dev vs Production ==="

# Dev row counts
echo ""
echo "--- DEV Environment ---"
railway env link dev
railway run -- psql "$DATABASE_URL" -c "
SELECT relname as table_name, n_live_tup as row_count
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY relname;
"

# Prod row counts
echo ""
echo "--- PROD Environment ---"
railway env link production
railway run -- psql "$DATABASE_URL" -c "
SELECT relname as table_name, n_live_tup as row_count
FROM pg_stat_user_tables
WHERE schemaname = 'public'
ORDER BY relname;
"
```

---

## Railway ↔ Local Development

### When Local is Out of Sync with Railway

This workflow refreshes your local database to match Railway's current state.

#### Option A: Using Railway CLI (Recommended)

```bash
# Step 1: Export from Railway Dev environment using railway run
railway env link dev
railway run -- pg_dump --no-acl --no-owner "$DATABASE_URL" > railway_dev_sync.sql

# Step 2: Reset your local database (Docker example)
docker compose down -v  # Removes the old volume
docker compose up -d    # Creates fresh database

# Step 3: Import Railway data to local
psql "postgresql://postgres:postgres@localhost:5432/planadvisor" \
  < railway_dev_sync.sql

# Step 4: Verify sync
psql "postgresql://postgres:postgres@localhost:5432/planadvisor" -c "\dt"
```

#### Option B: Using Railway Dashboard + Public URL

```bash
# Get DATABASE_PUBLIC_URL from Railway Dashboard:
# Dashboard → Dev Environment → Postgres Service → Connect tab → Copy "Public URL"
# Example: postgresql://postgres:PASSWORD@switchback.proxy.rlwy.net:50670/railway

# Export from Railway Dev using the public URL
export RAILWAY_PUBLIC_URL="postgresql://postgres:PASSWORD@HOST:PORT/railway"
pg_dump --no-acl --no-owner "$RAILWAY_PUBLIC_URL" > railway_dev_sync.sql

# Import to local
psql "postgresql://postgres:postgres@localhost:5432/planadvisor" \
  < railway_dev_sync.sql
```

### Export from Local to Railway

Only use this if you have specific local changes you need to push up:

```bash
# Export local database
pg_dump --no-acl --no-owner \
  "postgresql://postgres:postgres@localhost:5432/planadvisor" \
  > local_backup.sql

# Import to Railway Dev (safer to test here first)
railway env link dev
railway run -- psql "$DATABASE_URL" < local_backup.sql

# If it works, then import to production (use with caution!)
railway env link production
railway run -- psql "$DATABASE_URL" < local_backup.sql
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
