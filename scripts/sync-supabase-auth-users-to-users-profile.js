#!/usr/bin/env node
/**
 * Pull every user from Supabase Auth and upsert into PostgreSQL `users_profile`.
 * users_profile.id = auth.users.id (JWT `sub`) so Railway matches Supabase prod UIDs.
 *
 * Env (load from .env in project root):
 *   SUPABASE_URL                  — prod project URL (e.g. https://xxxx.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY     — Project Settings → API → service_role (never commit)
 *   DATABASE_URL                  — Railway Postgres (or local); not required for --dry-run
 *
 * Usage:
 *   node scripts/sync-supabase-auth-users-to-users-profile.js
 *   node scripts/sync-supabase-auth-users-to-users-profile.js --dry-run
 *
 * Optional metadata on each Auth user (user_metadata or app_metadata):
 *   role       — admin | internal | client (default: client)
 *   full_name  — string (default: part before @ in email)
 *   company_id — UUID string, optional (clients without company_id still insert; fix via admin API)
 *
 * Set active = false when banned_until is set and still in effect.
 */
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const dryRun = process.argv.includes('--dry-run');

if (dryRun) {
  console.log(
    'Dry run — preview only. No PostgreSQL writes. To upsert into Railway, run: npm run db:sync-users\n',
  );
}

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (!supabaseUrl) die('Missing SUPABASE_URL in .env.');
if (!serviceKey) {
  die(
    'Missing SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Supabase Dashboard → Project Settings → API → service_role (secret).\n' +
      'Remove it from .env after syncing if you prefer.',
  );
}
if (!databaseUrl && !dryRun) die('Missing DATABASE_URL in .env.');

function sslForUrl(url) {
  const m = url.match(/@([^:/]+)/);
  const host = m ? m[1] : '';
  if (host === 'localhost' || host === '127.0.0.1') return false;
  return { rejectUnauthorized: false };
}

const VALID_ROLES = new Set(['admin', 'internal', 'client']);

function pickRole(user) {
  const um = user.user_metadata || {};
  const am = user.app_metadata || {};
  const r = [um.role, am.role, am.user_role].find((x) => typeof x === 'string');
  const normalized = r ? String(r).toLowerCase().trim() : 'client';
  return VALID_ROLES.has(normalized) ? normalized : 'client';
}

function pickFullName(user) {
  const um = user.user_metadata || {};
  const name =
    um.full_name ||
    um.name ||
    um.fullName ||
    um.display_name ||
    um.displayName ||
    (user.email ? user.email.split('@')[0] : null);
  return name ? String(name) : 'User';
}

function pickCompanyId(user) {
  const um = user.user_metadata || {};
  const am = user.app_metadata || {};
  const raw = um.company_id ?? am.company_id ?? um.companyId;
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) {
    return { error: `invalid company_id for ${user.id}: ${JSON.stringify(raw)}` };
  }
  return { uuid: s };
}

function isActive(user) {
  if (user.banned_until) {
    const until = new Date(user.banned_until);
    if (!Number.isNaN(until.getTime()) && until > new Date()) return false;
  }
  return true;
}

async function listAllAuthUsers(supabase) {
  const all = [];
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const batch = data?.users ?? [];
    all.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
  }
  return all;
}

async function main() {
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const users = await listAllAuthUsers(supabase);
  console.log(`Found ${users.length} user(s) in Supabase Auth.`);

  const rows = [];
  for (const user of users) {
    if (!user.email) {
      console.warn(`Skip ${user.id}: no email (phone-only or incomplete).`);
      continue;
    }
    const company = pickCompanyId(user);
    if (company && company.error) {
      console.warn(company.error);
      continue;
    }
    rows.push({
      id: user.id,
      email: user.email,
      full_name: pickFullName(user),
      role: pickRole(user),
      company_id: company && company.uuid ? company.uuid : null,
      active: isActive(user),
    });
  }

  if (dryRun) {
    console.table(rows.map((r) => ({ id: r.id, email: r.email, role: r.role, active: r.active })));
    console.log('Dry run finished — 0 rows written. Run without --dry-run to upsert into DATABASE_URL.');
    return;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslForUrl(databaseUrl),
    max: 2,
  });

  console.log('Upserting into PostgreSQL (DATABASE_URL)…\n');
  const sql = `
    INSERT INTO users_profile (id, email, full_name, role, company_id, active)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
      email      = EXCLUDED.email,
      full_name  = EXCLUDED.full_name,
      role       = EXCLUDED.role,
      company_id = COALESCE(EXCLUDED.company_id, users_profile.company_id),
      active     = EXCLUDED.active
    RETURNING id, email, role, company_id, active`;

  let ok = 0;
  for (const r of rows) {
    try {
      await pool.query(sql, [
        r.id,
        r.email,
        r.full_name,
        r.role,
        r.company_id,
        r.active,
      ]);
      ok += 1;
      console.log(`Upserted ${r.email} (${r.id}) role=${r.role}`);
    } catch (err) {
      if (err.code === '23505') {
        console.error(
          `Conflict for ${r.email} (${r.id}): ${err.message}\n` +
            'Another row may already use this email. Check users_profile for that email.',
        );
      } else if (err.code === '23503') {
        console.error(
          `FK failed for ${r.email} (${r.id}): ${err.message}\n` +
            'company_id must exist in companies() or be null.',
        );
      } else {
        console.error(`Failed ${r.email}:`, err.message);
      }
    }
  }

  await pool.end();
  console.log(`Done. Upserted ${ok} / ${rows.length} row(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
