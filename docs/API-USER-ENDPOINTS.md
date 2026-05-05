# PA Plan Advisor API — Endpoint reference & Postman

This document lists **all implemented HTTP endpoints** in this repo, with **Postman-oriented examples**.

**Ready-to-import collection:** [`postman/PA-Plan-Advisor-API.postman_collection.json`](../postman/PA-Plan-Advisor-API.postman_collection.json) — import via Postman **File → Import**. It includes **`X-API-Key`** + **Bearer** on all `/api/*` requests; **Platform** (`/live`, `/health`) has no auth headers.

Architectural background and the full product matrix: [PA-PLAN-ADVISOR-GUIDE.md](./PA-PLAN-ADVISOR-GUIDE.md).  
Railway deploy steps: [RAILWAY-DEPLOYMENT-GUIDE.md](./RAILWAY-DEPLOYMENT-GUIDE.md).

## Base URLs

| Environment | `base_url` (no trailing slash) |
|-------------|--------------------------------|
| **Railway (dev)** | `https://planadvisor-dev.up.railway.app` |
| **Local** | `http://localhost:3000` |

In Postman, set:

| Variable | Purpose |
|----------|---------|
| `base_url` | `https://planadvisor-dev.up.railway.app` or `http://localhost:3000` |
| `pa_plan_api_key` | Same value as server env **`PA_PLAN_API_KEY`** (required on Railway in production for all routes except probes) |
| `access_token` | Supabase JWT after login |
| `profile_id`, `scenario_id`, … | From prior responses |

**Postman secrets:** Add **`pa_plan_api_key`** and **`access_token`** to a **Postman Environment** (recommended) or Globals — **not** as empty collection defaults. **Select that environment** in the top-right dropdown before sending. The repo collection sends **`Authorization: Bearer {{access_token}}`** and **`X-API-Key`** as **explicit headers** on each `/api/*` request.

**Default headers for every request under `/api`:** **`X-API-Key: {{pa_plan_api_key}}`** and **`Authorization: Bearer {{access_token}}`** when the gate and JWT are required. Omit **`X-API-Key`** only for **`GET /live`** and **`GET /health`**, or when running locally with **`PA_PLAN_API_KEY`** unset.

**Path prefixes**

- **No `/api` prefix:** `GET /live`, `GET /health` — **no API key required** (probes stay simple).
- **API key gate:** when **`PA_PLAN_API_KEY`** is set, **all other paths** (including every `/api/*` route) must send **`X-API-Key`**; **`OPTIONS`** preflight is exempt so CORS works.
- **Authenticated catalog & flows:** `/api/...` — **API key** (if enabled) **+** Supabase **Bearer** token, except the two probe paths above.
- **Admin:** `/api/admin/...` — same headers; user must also have **`admin`** in `users_profile`.

---

## Authentication

### API key (all routes except platform probes)

Railway (and `.env`): set **`PA_PLAN_API_KEY`**. When this variable is **non-empty**, every request must include:

```http
X-API-Key: <same value as PA_PLAN_API_KEY>
```

**Exceptions:** `GET /live` and `GET /health` only — no API key.

In **`NODE_ENV=production`**, **`PA_PLAN_API_KEY` is required** at startup (the process exits if unset). Local dev may omit it; the gate is then disabled and a warning is logged.

Wrong or missing key → **`401`** with `{ "error": "Invalid or missing API key.", "hint": "..." }`.  
Hints distinguish **empty/missing header** (Postman variable / Environment not selected) from **value mismatch** (copy from wrong Railway service or extra characters).

**Railway:** `PA_PLAN_API_KEY` must live on the **same service** that runs this API (e.g. **pa-plan-api**), not on Postgres or Supabase. The value must match what you send in **`X-API-Key`** (no quotes unless they are part of the secret).

This check runs **before** JWT validation.

### Supabase JWT (most `/api/*` routes)

Most routes also use a **Supabase access token**. Send **both** headers when the API key gate is enabled:

```http
X-API-Key: {{pa_plan_api_key}}
Authorization: Bearer {{access_token}}
```

(Postman normalizes `X-API-Key`; Express accepts `x-api-key`.)

The API validates the JWT with Supabase, then loads **`role`** and **`active`** from PostgreSQL (`users_profile`).  
Missing profile → **`403`** with **`User profile not found`** — see [Fix: no `users_profile` row](#fix-no-users_profile-row-for-your-supabase-user). Inactive user → **`403`**.

**Obtain `access_token` (example — replace with your Supabase project):**

```http
POST https://<project-ref>.supabase.co/auth/v1/token?grant_type=password
apikey: <SUPABASE_ANON_KEY>
Content-Type: application/json

{
  "email": "you@example.com",
  "password": "your-password"
}
```

Use `access_token` from the JSON response in Postman variable `{{access_token}}`.

### Fix: no `users_profile` row for your Supabase user

Supabase only proves **who** signed in. This API also requires a matching row in **Railway Postgres**:

- **`users_profile.id`** must equal **`auth.users.id`** (the UUID shown in Supabase → **Authentication → Users**).

**First admin (no API user yet):** insert via SQL against Railway Postgres (e.g. Railway **Query** tab / `railway connect` / `psql`), after creating `companies` if needed:

```sql
INSERT INTO users_profile (id, email, full_name, role, company_id, active)
VALUES (
  '<paste-user-uuid-from-supabase>',
  'you@example.com',
  'Your Name',
  'admin',
  NULL,
  true
);
```

Use a real **`company_id`** if you already have a `companies` row and want the user linked to it (`SELECT id FROM companies LIMIT 1`).

Or use **`POST /api/admin/users`** with another user’s **admin** JWT once that admin exists.

**Postman:** after deploying the API update, a **`403`** may include **`supabase_user_id`** so you can paste the correct UUID into SQL or the admin payload.

**Postman tip:** Add collection variables `pa_plan_api_key` and `access_token`. Use **Authorization** → Bearer `{{access_token}}`, and add a collection header `X-API-Key` = `{{pa_plan_api_key}}` (or per-request), whenever `PA_PLAN_API_KEY` is set on the server.

**Do not** set the collection’s **Authorization** tab to **API Key** or **Bearer Token** if your imported requests already send **`Authorization: Bearer {{access_token}}`** and **`X-API-Key`** as headers — Postman may send an **empty** Bearer. Use **Collection auth: No Auth**, create an **Environment**, run **`0. Supabase — login`** in the bundled collection to save **`access_token`**, and keep **`pa_plan_api_key`** in the same environment.

---

## Quick index

**Credentials column:** **`—`** = no headers. **`X-API-Key`** = required **only when** `PA_PLAN_API_KEY` is set on the server (always on Railway prod). **`Bearer`** = Supabase access token. Real requests use **both** where both cells apply.

| Method | Path | Credentials | Roles |
|--------|------|-------------|--------|
| `GET` | `/live` | — | — |
| `GET` | `/health` | — | — |
| `GET` | `/api/me` | X-API-Key + Bearer | admin, internal, client |
| `GET` | `/api/user/dashboard` | X-API-Key + Bearer | admin, internal, client |
| `GET` | `/api/countries` | X-API-Key + Bearer | admin, internal, client |
| `GET` | `/api/providers` | X-API-Key + Bearer | admin, internal, client |
| `GET` | `/api/calculator/available-countries` | X-API-Key + Bearer | admin, internal, client |
| `GET` | `/api/calculator/profile/:id` | X-API-Key + Bearer | admin, internal, client |
| `POST` | `/api/calculator/calculate` | X-API-Key + Bearer | admin, internal, client |
| `GET` | `/api/scenarios` | X-API-Key + Bearer | admin, internal, client |
| `GET` | `/api/scenarios/:id` | X-API-Key + Bearer | admin, internal, client |
| `POST` | `/api/scenarios/:id/generate-summary` | X-API-Key + Bearer | admin, internal, client* |
| `POST` | `/api/admin/countries` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/providers` | X-API-Key + Bearer | **admin** |
| `GET` | `/api/admin/users` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/users` | X-API-Key + Bearer | **admin** |
| `PATCH` | `/api/admin/users/:id` | X-API-Key + Bearer | **admin** |
| `GET` | `/api/admin/profiles` | X-API-Key + Bearer | **admin** |
| `GET` | `/api/admin/profiles/:id` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/profiles` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/profiles/:id/activate` | X-API-Key + Bearer | **admin** |
| `GET` | `/api/admin/documents` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/documents/upload` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/documents/analyze` | X-API-Key + Bearer | **admin** |
| `PATCH` | `/api/admin/rules/:id` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/rules/:id/approve` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/rules/:id/reject` | X-API-Key + Bearer | **admin** |
| `PATCH` | `/api/admin/plans/:id` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/plans/:id/approve` | X-API-Key + Bearer | **admin** |
| `POST` | `/api/admin/plans/:id/reject` | X-API-Key + Bearer | **admin** |

\* See [Scenario access](#scenario-access-rules).

---

## Platform & health

### `GET /live`

**Auth:** none — **`X-API-Key` not required** (Railway / probes).  
**Purpose:** Fast liveness (no database).

**Postman**

- Method: `GET`
- URL: `{{base_url}}/live`
- Do **not** set collection auth override here; no **`X-API-Key`** needed.

**Example response**

```json
{ "status": "ok" }
```

---

### `GET /health`

**Auth:** none — **`X-API-Key` not required.**  
**Purpose:** Process is up; JSON reports DB reachability. **Always HTTP 200.**

**Postman**

- Method: `GET`
- URL: `{{base_url}}/health`
The API key middleware **does not run** for this path — probes stay unauthenticated.

**Example (DB OK)**

```json
{
  "status": "ok",
  "db": "connected",
  "agents": { "doc_agent": true, "summary_agent": true },
  "timestamp": "2026-04-30T12:00:00.000Z"
}
```

If Postgres is unreachable, expect `"status": "degraded"` and `"db": "unreachable"` (still **200**).

---

## Shared Postman defaults (all `/api/*` sections below)

Use a **Postman Environment** with **`pa_plan_api_key`** and **`access_token`**. Re-import [`postman/PA-Plan-Advisor-API.postman_collection.json`](../postman/PA-Plan-Advisor-API.postman_collection.json) so each request includes explicit **`Authorization: Bearer {{access_token}}`** (avoids empty Bearer when collection variables shadow the environment).

1. **Headers:** `X-API-Key` = `{{pa_plan_api_key}}`
2. **Headers:** `Authorization` = `Bearer {{access_token}}`

`multipart/form-data` (**document upload**) keeps **`X-API-Key`** and **`Authorization`** on the **Headers** tab, not in the form body.

The per-endpoint **Postman** bullets below may only mention Bearer for brevity — the imported collection already includes both headers.

---

## Session & dashboard

### `GET /api/me`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/me`
- Authorization: Bearer `{{access_token}}`

Returns `users_profile` + company fields and `client_summary_enabled` (placeholder flag).

---

### `GET /api/user/dashboard`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/user/dashboard`
- Authorization: Bearer `{{access_token}}`

Returns `active_profiles`, `recent_scenarios`, `scenario_stats`, and `ai_calls_this_month` (internal/admin only for the last).

---

## Catalog

### `GET /api/countries`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/countries`
- Authorization: Bearer `{{access_token}}`

**Behavior:** **admin** — all countries. **internal/client** — only countries that have at least one **active** `calculation_profiles` row.

---

### `GET /api/providers`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/providers`
- Authorization: Bearer `{{access_token}}`

---

## Calculator

### `GET /api/calculator/available-countries`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/calculator/available-countries`
- Authorization: Bearer `{{access_token}}`

Returns active profiles as rows with `profile_id`, country/provider info, `rules_count`, `plans_count`. Use a `profile_id` in the next calls.

---

### `GET /api/calculator/profile/:id`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/calculator/profile/{{profile_id}}`
- Authorization: Bearer `{{access_token}}`

**client** users only receive data if the profile **`status`** is `active` (**403** otherwise).

---

### `POST /api/calculator/calculate`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/calculator/calculate`
- Authorization: Bearer `{{access_token}}`
- Headers: `Content-Type: application/json`
- Body (raw JSON):

```json
{
  "profile_id": "{{profile_id}}",
  "client_name": "Acme Corp",
  "inputs": {
    "issued_b2b_domestic": 500,
    "issued_credit_note_domestic": 400,
    "issued_b2b_foreign_er": 0,
    "issued_b2c_consumer_er": 0,
    "issued_payment_er": 0,
    "received_domestic_supplier": 4000,
    "received_foreign_supplier_er": 2000,
    "received_foreign_daily_report_days": 0
  }
}
```

> Replace `inputs` keys with those returned by `GET /api/calculator/profile/:id` for your profile (the sample keys above match the France B2Brouter seed).

**Success:** Full breakdown, `plan_comparison`, `recommended_plan`, plus `scenario_id` and `created_at`.  
**Errors:** `400` missing `profile_id`/`inputs`; `404` profile; `403` client + non-active profile; `422` no approved rules or plans.

Save `scenario_id` from the response into Postman variable `{{scenario_id}}`.

---

## Scenarios

### Scenario access rules

| Role | `GET /api/scenarios` | `GET /api/scenarios/:id` / `POST .../generate-summary` |
|------|----------------------|--------------------------------------------------------|
| **admin** | All (up to 200) | Full access |
| **internal** | Scenarios whose creator is **admin** or **internal** | **403** if scenario creator is **client** |
| **client** | `created_by` = self or same `company_id` | Same ownership/company check |

---

### `GET /api/scenarios`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/scenarios`
- Authorization: Bearer `{{access_token}}`

---

### `GET /api/scenarios/:id`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/scenarios/{{scenario_id}}`
- Authorization: Bearer `{{access_token}}`

---

### `POST /api/scenarios/:id/generate-summary`

**Auth:** Bearer. **Requires** `SUMMARY_AGENT_URL` and `AGENT_API_KEY` on the server — otherwise **`503`** with `summary_agent_unavailable` or `summary_agent_misconfigured`.

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/scenarios/{{scenario_id}}/generate-summary`
- Authorization: Bearer `{{access_token}}`
- Body: none

**Success**

```json
{ "summary": "..." }
```

AI quota and rate limits may return **`429`**.

---

## Admin — catalog

### `POST /api/admin/countries`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/countries`
- Authorization: Bearer `{{access_token}}` (admin user)
- Body (raw JSON):

```json
{
  "code": "ES",
  "name": "Spain"
}
```

`code` is stored uppercased. **409** if code exists.

---

### `POST /api/admin/providers`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/providers`
- Authorization: Bearer `{{access_token}}`
- Body (raw JSON):

```json
{
  "name": "Example PDP",
  "type": "PDP"
}
```

`type` is free text in DB (e.g. `PA`, `PDP`).

---

## Admin — users

### `GET /api/admin/users`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/admin/users`
- Authorization: Bearer `{{access_token}}`

---

### `POST /api/admin/users`

Creates `users_profile` after the user exists in Supabase Auth.

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/users`
- Authorization: Bearer `{{access_token}}`
- Body (raw JSON):

```json
{
  "supabase_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "email": "user@example.com",
  "full_name": "Sample User",
  "role": "client",
  "company_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

- `role`: `admin` | `internal` | `client`
- `company_id` **required** when `role` is `client`

---

### `PATCH /api/admin/users/:id`

**Postman**

- Method: `PATCH`
- URL: `{{base_url}}/api/admin/users/{{user_id}}`
- Authorization: Bearer `{{access_token}}`
- Body (raw JSON) — include any fields to update:

```json
{
  "role": "internal",
  "company_id": null,
  "active": true,
  "full_name": "Updated Name"
}
```

---

## Admin — calculation profiles

### `GET /api/admin/profiles`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/admin/profiles`
- Authorization: Bearer `{{access_token}}`

---

### `GET /api/admin/profiles/:id`

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/admin/profiles/{{profile_id}}`
- Authorization: Bearer `{{access_token}}`

Returns profile row plus nested `rules`, `plans`, `assumptions`.

---

### `POST /api/admin/profiles`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/profiles`
- Authorization: Bearer `{{access_token}}`
- Body (raw JSON):

```json
{
  "country_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "provider_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "version": "v1.1",
  "currency": "EUR",
  "calculation_basis": "PA transactions"
}
```

Creates profile in **`draft`** status.

---

### `POST /api/admin/profiles/:id/activate`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/profiles/{{profile_id}}/activate`
- Authorization: Bearer `{{access_token}}`
- Body: none

Requires ≥ **1** approved rule and ≥ **1** approved plan. Archives any other **active** profile for the same country+provider.

---

## Admin — documents

### `GET /api/admin/documents`

**Query:** exactly one of `profile_id` or `country_id` (required).

**Postman**

- Method: `GET`
- URL: `{{base_url}}/api/admin/documents?profile_id={{profile_id}}`
- Authorization: Bearer `{{access_token}}`

(`storage_path` is never returned.)

---

### `POST /api/admin/documents/upload`

**Multipart form** — field name **`file`**. Requires Railway Volume / `DOCUMENTS_PATH` configured.

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/documents/upload`
- Authorization: Bearer `{{access_token}}`
- Body: **form-data**
  - `file` — type *File* (allowed: `.pdf`, `.docx`, `.xlsx`, `.csv`, `.txt`, `.md`)
  - `country_id` — text
  - `provider_id` — text
  - `document_type` — text, one of:  
    `provider_pricing` | `transaction_guide` | `country_legal` | `contract` | `commercial_confirmation` | `other`
  - `profile_id` — text (optional; used as folder key when set)
  - `description` — text (optional)

---

### `POST /api/admin/documents/analyze`

Calls the **document agent** (`DOC_AGENT_URL`) with `AGENT_API_KEY`; subject to AI quota and stricter rate limit.

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/documents/analyze`
- Authorization: Bearer `{{access_token}}`
- Headers: `Content-Type: application/json`
- Body (raw JSON):

```json
{
  "profile_id": "{{profile_id}}",
  "document_ids": ["uuid-doc-1", "uuid-doc-2"]
}
```

May return **451** if the agent blocks on copyright.

---

## Admin — transaction rules

### `PATCH /api/admin/rules/:id`

**Postman**

- Method: `PATCH`
- URL: `{{base_url}}/api/admin/rules/{{rule_id}}`
- Authorization: Bearer `{{access_token}}`
- Body (raw JSON) — all optional; only sent fields update:

```json
{
  "label": "Updated label",
  "direction": "Issued",
  "obligation": "E-invoicing",
  "operation_group": "Domestic",
  "pa_transactions_per_item": 2,
  "reason": "…",
  "source_excerpt": "…",
  "confidence": "high"
}
```

---

### `POST /api/admin/rules/:id/approve`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/rules/{{rule_id}}/approve`
- Authorization: Bearer `{{access_token}}`
- Body: none

---

### `POST /api/admin/rules/:id/reject`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/rules/{{rule_id}}/reject`
- Authorization: Bearer `{{access_token}}`
- Body (raw JSON, optional):

```json
{
  "reason": "Optional rejection note"
}
```

---

## Admin — plans

### `PATCH /api/admin/plans/:id`

**Postman**

- Method: `PATCH`
- URL: `{{base_url}}/api/admin/plans/{{plan_id}}`
- Authorization: Bearer `{{access_token}}`
- Body (raw JSON) — optional fields:

```json
{
  "plan_name": "Plan 3",
  "included_pa_transactions": 7200,
  "annual_fee": 1218,
  "monthly_fee": null,
  "extra_transaction_cost": 0.222,
  "source_excerpt": "…",
  "confidence": "high"
}
```

---

### `POST /api/admin/plans/:id/approve`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/plans/{{plan_id}}/approve`
- Authorization: Bearer `{{access_token}}`

---

### `POST /api/admin/plans/:id/reject`

**Postman**

- Method: `POST`
- URL: `{{base_url}}/api/admin/plans/{{plan_id}}/reject`
- Authorization: Bearer `{{access_token}}`
- Body: none

---

## Suggested Postman order (smoke test on Railway)

Use **`{{base_url}}` = `https://planadvisor-dev.up.railway.app`**.

1. **Collection → Authorization → No Auth** (do not use API Key / Bearer at collection level).
2. Create/select **Environment** with `pa_plan_api_key`, `supabase_url`, `supabase_anon_key`, `supabase_email`, `supabase_password`.
3. `GET {{base_url}}/live` — no API key, no Bearer.
4. `GET {{base_url}}/health` — no API key, no Bearer.
5. Run **`0. Supabase — login`** once — saves **`access_token`** into the Environment (or paste JWT manually into `access_token`).
6. `GET {{base_url}}/api/me`
7. `GET {{base_url}}/api/user/dashboard`
8. `GET {{base_url}}/api/countries` · `GET {{base_url}}/api/providers`
9. `GET {{base_url}}/api/calculator/available-countries` → copy `profile_id`
10. `GET {{base_url}}/api/calculator/profile/{{profile_id}}`
11. `POST {{base_url}}/api/calculator/calculate` → copy `scenario_id`
12. `GET {{base_url}}/api/scenarios` · `GET {{base_url}}/api/scenarios/{{scenario_id}}`
13. `POST {{base_url}}/api/scenarios/{{scenario_id}}/generate-summary` — expect **503** if summary agent is not configured (valid contract test).

Admin-only steps (as an admin user): catalog → profiles → rules/plans → activate → documents as needed.

---

## Common HTTP status codes

| Code | Meaning |
|------|---------|
| `401` | Missing/invalid **`X-API-Key`** (when `PA_PLAN_API_KEY` is set) — checked **first**; or missing/invalid Bearer token (`Unauthorized` JSON from Supabase validation) |
| `403` | Inactive user, missing `users_profile`, or role/access rule |
| `404` | Unknown resource |
| `409` | Conflict (e.g. duplicate country code, duplicate user profile) |
| `422` | Validation / business rule (e.g. profile activation, calculator prerequisites) |
| `429` | Global rate limit, AI rate limit, or AI quota (`lib/quota.js`) |
| `451` | Document analysis blocked (copyright) |
| `503` | Summary agent not configured (`generate-summary` only) |

---

## Local / seed note

To exercise the calculator on a fresh DB: apply `db/schema.sql`, ensure an **admin** `users_profile` exists, then run `db/seed_france_b2brouter_v1.sql` (or equivalent) so at least one profile is **active** with approved rules and plans. The `users_profile.id` must match the Supabase `auth.users.id` UUID for real logins.

**API key:** locally you may leave **`PA_PLAN_API_KEY`** unset so **`X-API-Key`** is not required; production on Railway must define it (see [Authentication](#authentication)).
