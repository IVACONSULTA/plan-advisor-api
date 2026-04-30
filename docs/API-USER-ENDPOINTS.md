# PA Plan Advisor API — User interaction endpoints

This document describes the **authenticated REST endpoints** that power **customer (`client`)** and **internal (`internal`)** flows: session/bootstrap, dashboard, countries/providers catalog, calculator, scenarios, and AI summaries. Admin-only setup (documents, analyses, profiles, rule approval) lives under `/api/admin/*` and is intentionally out of scope here.

Architectural background, env vars, and the full endpoint matrix are in [PA-PLAN-ADVISOR-GUIDE.md](./PA-PLAN-ADVISOR-GUIDE.md).

**Base URL (local):** `http://localhost:3000`  
**API prefix:** all routes below assume `/api` unless noted. Operational checks use **`GET /live`** (liveness only) and **`GET /health`** (liveness + DB ping in JSON; always HTTP **200**) — neither uses the `/api` prefix.

---

## Authentication

Every endpoint below requires a valid **Supabase access token** (JWT) obtained from the Frontend login (`signInWithPassword`) or Supabase tooling.

Send the header on every request:

```http
Authorization: Bearer <access_token>
```

The API validates the JWT with Supabase Auth, then loads **`role`** and **`active`** from PostgreSQL (`users_profile`). Deactivated users receive `403`. Users missing a `users_profile` row receive `403` with `User profile not found`.

---

## Endpoints overview

| Method | Path | Roles | Purpose |
|--------|------|--------|---------|
| `GET` | `/api/me` | admin, internal, client | Bootstrap: profile, company, UI flags (`client_summary_enabled`). |
| `GET` | `/api/user/dashboard` | admin, internal, client | Home widgets: active profiles (with rule/plan counts), recent scenarios, aggregates. |
| `GET` | `/api/countries` | admin, internal, client | Country list (admin: all countries; others: countries with ≥1 **active** profile). |
| `GET` | `/api/providers` | admin, internal, client | Provider/PA catalog. |
| `GET` | `/api/calculator/available-countries` | admin, internal, client | Active profiles as country+provider rows (includes `rules_count`, `plans_count`). |
| `GET` | `/api/calculator/profile/:id` | admin, internal, client | Dynamic calculator inputs for a profile (`client` only if profile is **active**). |
| `POST` | `/api/calculator/calculate` | admin, internal, client | Deterministic calculation; creates a **scenario** (`client` only on **active** profiles). |
| `GET` | `/api/scenarios` | admin, internal, client | Scenario list (filtered by role; see below). |
| `GET` | `/api/scenarios/:id` | admin, internal, client | Full scenario + stored result JSON. |
| `POST` | `/api/scenarios/:id/generate-summary` | admin, internal, client* | Calls summary agent App 4; stores `ai_summary`. |

\* **Client:** only own/company scenarios; **internal:** only scenarios whose creator is `admin` or `internal`; **admin:** all. Quota middleware applies (`lib/quota.js`).  
Requires `SUMMARY_AGENT_URL` and `AGENT_API_KEY` (`503` if missing).

---

## Role semantics (lists and access)

### `GET /api/scenarios`

- **admin:** All scenarios (up to 200).
- **internal:** Scenarios whose **creator** is `admin` or `internal` (up to 200).
- **client:** Rows where `created_by` is the current user **or** `company_id` matches the user’s `users_profile.company_id` (when set).

### `GET /api/scenarios/:id` / `POST .../generate-summary`

- **client:** Same ownership/company rules as list.
- **internal:** Forbidden if scenario was created by a **client** user.
- **admin:** Full access.

### `POST /api/calculator/calculate`

- **`company_id`** on the inserted scenario is copied from **`users_profile.company_id`** when present (helps company-wide visibility for clients).

---

## Request/response notes

### `POST /api/calculator/calculate`

**Body (JSON):**

```json
{
  "profile_id": "uuid-of-calculation_profiles",
  "client_name": "Acme Corp (optional)",
  "inputs": {
    "issued_einvoicing": 1000,
    "...": 0
  }
}
```

**Success:** Returns calculation breakdown, recommendation, `scenario_id`, and `created_at`.  
**Errors:** `404` unknown profile; `403` client + non-active profile; `422` no approved rules/plans.

### `POST /api/scenarios/:id/generate-summary`

No body required. On success: `{ "summary": "..." }`.  
If the summary agent is not configured, the API returns **`503`** with `summary_agent_unavailable` or `summary_agent_misconfigured` so you can distinguish misconfiguration from agent errors.

---

## Testing with Postman

### 1. Environment variables

Create a Postman environment (or collection variables) with:

| Variable | Example |
|----------|---------|
| `base_url` | `http://localhost:3000` |
| `access_token` | *(paste Supabase JWT after login)* |
| `profile_id` | *(from `GET .../calculator/available-countries`)* |
| `scenario_id` | *(from `POST .../calculate` response)* |

### 2. Collection-level Authorization

1. Edit your collection → **Authorization** tab.  
2. Type: **Bearer Token**.  
3. Token: `{{access_token}}`.

Individual requests will inherit this unless overridden.

### 3. Suggested request order

1. **`GET {{base_url}}/health`** — No auth. Always **HTTP 200**; JSON shows `status: ok` when `db: connected`, or `status: degraded` when `db: unreachable`. (**`GET {{base_url}}/live`** is a trivial liveness probe used by Railway — no DB check.)
2. **Obtain JWT** — Use the Frontend login or Supabase dashboard / Auth API; copy the **access token** into `access_token`.  
3. **`GET {{base_url}}/api/me`** — Confirms `users_profile` exists and role is correct.  
4. **`GET {{base_url}}/api/user/dashboard`** — Verifies active profiles and recent scenarios.  
5. **`GET {{base_url}}/api/calculator/available-countries`** — Pick a `profile_id`.  
6. **`GET {{base_url}}/api/calculator/profile/{{profile_id}}`** — Inspect `inputs` keys.  
7. **`POST {{base_url}}/api/calculator/calculate`** — Body as above; save `scenario_id`.  
8. **`GET {{base_url}}/api/scenarios`** and **`GET {{base_url}}/api/scenarios/{{scenario_id}}`** — List + detail.  
9. **`POST {{base_url}}/api/scenarios/{{scenario_id}}/generate-summary`** — Only after `SUMMARY_AGENT_URL` and `AGENT_API_KEY` are set; otherwise expect **503** with a clear JSON error (still useful for Postman contract tests).

### 4. Common HTTP status codes

| Code | Meaning |
|------|---------|
| `401` | Missing/invalid Bearer token. |
| `403` | Inactive user, missing profile, or role/ownership violation. |
| `404` | Unknown `profile_id` or `scenario_id`. |
| `422` | Calculator prerequisites missing (no approved rules/plans). |
| `429` | AI quota exceeded (`checkAIQuota`) or AI rate limiter. |
| `503` | Summary agent not configured (`/api/scenarios/.../generate-summary`). **`/health` does not use 503** — use the JSON body to see DB status. |

### 5. Local database seed

To exercise the calculator end-to-end, apply `db/schema.sql` then run `db/seed_france_b2brouter_v1.sql` (or your own seed) so at least one profile is **active** with approved rules and plans. Ensure a matching `users_profile` row exists for your Supabase user **id** (same UUID as `auth.users.id`).

---

## Related admin routes (reference only)

These are **not** customer/internal “interaction” routes but are required to **produce** data the calculator consumes:

- `POST /api/admin/countries`, `POST /api/admin/providers` — Catalog (admin).  
- Profiles, documents, analyses, rules/plans — see `server.js` and `routes/` for mounted paths.

After the admin workflow activates a profile, the user endpoints above become meaningful for `client` and `internal` testers.
