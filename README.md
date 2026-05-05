# PA Plan Advisor API

Backend HTTP API for **PA Plan Advisor**: countries, providers, calculation profiles, plans, documents, calculator flows, and optional AI helpers. Built with **Express** and deployed primarily on **Railway** alongside **PostgreSQL**.

## Technical architecture (overview)

```mermaid
flowchart LR
  subgraph clients [Clients]
    Web[Browsers / BFF]
    Postman[Postman / scripts]
  end

  subgraph api [This service — Express]
    MW[Helmet, CORS, rate limit]
    Key[X-API-Key gate when configured]
    Auth[Supabase JWT + users_profile]
    Routes[REST routes under /api]
    MW --> Key --> Routes
    Auth --> Routes
  end

  subgraph idp [Identity]
    SA[Supabase Auth]
  end

  subgraph data [Data and files]
    PG[(PostgreSQL — business data)]
    FS[DOCUMENTS_PATH — uploaded files]
  end

  subgraph agents [Optional]
    DA[Doc agent]
    SA2[Summary agent]
  end

  Web --> MW
  Postman --> MW
  Routes --> PG
  Routes --> FS
  Routes --> Auth
  Auth --> SA
  Routes --> DA
  Routes --> SA2
```

- **Runtime:** Node.js (see `package.json` `engines`), **Express 5**, `pg` connection pool to PostgreSQL.
- **Business database:** All catalog and transactional data live in **PostgreSQL** (`DATABASE_URL`). Schema is in `db/schema.sql` (companies, `users_profile`, countries, providers, profiles, rules, plans, documents, scenarios, etc.).
- **Identity:** **Supabase Auth** validates **Bearer** JWTs only. Roles and company linkage are read from **`users_profile`** in PostgreSQL (`id` must match Supabase `auth.users.id`). There is no application database on Supabase for this API.
- **Security middleware:** Helmet, CORS (`FRONTEND_URL` or `*`), global rate limiting, then **`X-API-Key`** when `PA_PLAN_API_KEY` is set (required in production). **`GET /live`** and **`GET /health`** skip the API key; **`OPTIONS`** is allowed for CORS preflight.
- **Health:** **`/live`** is a fast liveness probe (no DB). **`/health`** returns HTTP 200 with a JSON `db` field (`connected` vs `unreachable`) after probing PostgreSQL.
- **Documents:** Uploads and derived files use **`DOCUMENTS_PATH`** on disk (Railway volume in production when configured).
- **Optional AI:** If **`DOC_AGENT_URL`** / **`SUMMARY_AGENT_URL`** (and **`AGENT_API_KEY`** for server-to-server calls) are set, document and summary routes can call those services.

Further detail: internal guide in `docs/PA-PLAN-ADVISOR-GUIDE.md`, user-facing API notes in `docs/API-USER-ENDPOINTS.md`, deployment in `docs/RAILWAY-DEPLOYMENT-GUIDE.md`.

---

## Running locally — database and API

### Prerequisites

- **Node.js** ≥ 20 and npm ≥ 10
- **PostgreSQL** 14+ (local install or Docker)
- A **Supabase** project: **URL** and **anon key** (used only to verify JWTs)

### 1. Start PostgreSQL

If you use Docker:

```bash
docker run -d --name pa-plan-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=planadvisor \
  -p 5432:5432 \
  postgres:16-alpine
```

Connection string for the next steps:

```bash
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/planadvisor"
```

### 2. Configure environment

Copy the example file and edit values (at minimum `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`):

```bash
cp .env.example .env
```

For local development, set **`NODE_ENV=development`** so the `pg` client does not require TLS to localhost. **`PA_PLAN_API_KEY`** can be omitted so the API key gate is disabled (see `lib/api-key.js`). To mirror production, set `PA_PLAN_API_KEY` and send header **`X-API-Key`** on requests (except `/live` and `/health`).

Optional:

- **`DOCUMENTS_PATH`** — directory for uploads (defaults can be a folder under the project; ensure it exists and is writable)
- **`FRONTEND_URL`** — CORS origin, or leave unset for `*`

### 3. Install dependencies and apply schema

```bash
npm install
npm run db:schema
```

`db:schema` runs `psql` via `scripts/run-psql-file.js`, which loads **`DATABASE_URL`** from **`.env`**. **`psql`** must be on your `PATH`.

### 4. Seed data (match production data from this repo)

Everything under `db/` that represents **known catalog / demo data** can be applied so your local DB matches what you get by running the same SQL on Railway (assuming production was seeded from these files only).

**One command (recommended)** — companies, users, France × B2Brouter calculator (rules, plans, assumptions):

```bash
npm run db:schema   # uses DATABASE_URL from .env (via scripts/run-psql-file.js)
npm run db:seed
```

`db:schema` and `db:seed` load **`.env`** from the project root. Ensure **`DATABASE_URL`** is set there (see §2 and the Docker example in §1). If Postgres is not running, `psql` will report a connection error on **`127.0.0.1:5432`** instead of the Unix-socket message.

Equivalent:

```bash
psql "$DATABASE_URL" -f db/seed_local_dev.sql
```

This runs, in order:

1. `db/seed_iva_consulta_companies_and_users.sql` — companies + `users_profile` (includes an **admin**, required by the next seed).
2. `db/seed_france_b2brouter_v1.sql` — country **FR**, provider **B2Brouter**, active profile **v1.0**, transaction rules, plans, assumptions.

Safe to **re-run** (uses `ON CONFLICT` / scoped deletes). Individual files are still available if you need only part of the data.

**Emails in `users_profile`** must match Supabase sign-in emails; **`users_profile.id`** must equal **Authentication → Users → User UID** (same as JWT `sub`).

**Sync prod Supabase Auth users into Railway `users_profile`**

1. In **`.env`**, set **`SUPABASE_URL`** to your **production** project, add **`SUPABASE_SERVICE_ROLE_KEY`** (Dashboard → **Project Settings** → **API** → `service_role` — treat as a secret), and set **`DATABASE_URL`** to your **Railway** Postgres URL.
2. **Preview only** (no writes to Postgres): `npm run db:sync-users -- --dry-run`
3. **Write to Railway:** `npm run db:sync-users` (same command **without** `--dry-run`)

Script: `scripts/sync-supabase-auth-users-to-users-profile.js`. It upserts **`id` = Auth user UUID**, **`email`**, **`full_name`** (from user metadata or derived), **`role`** (`user_metadata.role` / `app_metadata.role` or default **`client`**), **`company_id`** (optional metadata UUID), **`active`** (respects ban). Roles outside `admin` / `internal` / `client` become **`client`**. Fix **`company_id`** and roles afterward with **`PATCH /api/admin/users/:id`** if metadata is missing. Remove **`SUPABASE_SERVICE_ROLE_KEY`** from `.env` when finished if you prefer not to keep it.

**If production has data not committed to git**, copy from Railway instead of (or after) the repo seeds:

```bash
pg_dump "$DATABASE_PUBLIC_URL" --data-only --no-owner --no-privileges | psql "$DATABASE_URL"
```

Use Railway’s **public** Postgres URL for `pg_dump` from your laptop, and your **local** `DATABASE_URL` as the restore target. Review `pg_dump` flags if you need schema-only or specific tables.

### 5. Query the local database

Use the same **`DATABASE_URL`** as in `.env` (load it in your shell if needed, or paste the URL string into the commands below).

**Interactive `psql` session**

```bash
psql "$DATABASE_URL"
```

Or by connection parameters (adjust host, user, database to match your setup):

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -d planadvisor
```

Inside `psql`: `\dt` lists tables, `\q` quits. End SQL statements with `;`.

**Example: read users (`users_profile`)**

This API stores people in **`users_profile`** (not a table named `users`). In an interactive `psql` session:

```sql
# Show tables list
\d

SELECT * FROM users_profile;

SELECT id, email, full_name, role, company_id, active, created_at
FROM users_profile
ORDER BY email;

SELECT * FROM users_profile WHERE email = 'you@example.com';
```

From the shell without opening `psql`:

```bash
psql "$DATABASE_URL" -c "SELECT id, email, role FROM users_profile ORDER BY email LIMIT 20;"
```

**Run a single query or a `.sql` file**

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM companies;"
psql "$DATABASE_URL" -f db/diagnostics_railway_companies_users.sql
```

**GUI clients** (TablePlus, pgAdmin, DBeaver, etc.): host `127.0.0.1`, port `5432`, and the database name, user, and password from your Docker or local Postgres config.

**`psql` not found:** install a Postgres client (e.g. on macOS: `brew install libpq` and follow Homebrew’s note to add `psql` to your `PATH`). If `npm run db:schema` already works, `psql` is available.

### 6. Run the API

```bash
npm run dev
```

The server listens on **`PORT`** (default **3000**), host **0.0.0.0**.

- **Liveness:** `GET http://localhost:3000/live`
- **Health (includes DB check):** `GET http://localhost:3000/health`

Authenticated routes need a valid **Supabase** access token in **`Authorization: Bearer …`** and a matching **`users_profile`** row for that user’s UUID. See `docs/API-USER-ENDPOINTS.md` for endpoints and Postman setup.
