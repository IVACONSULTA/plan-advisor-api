## Summary

Wires **profile metadata into the Document Agent**, replaces **mock-only AI analysis endpoints** with real `document_analyses` queries, adds **admin user detail** lookup, and improves **CORS** for multi-origin / Netlify deploy previews.

Pairs with PlanAdvisorFront admin AI analyses and user edit pages (`feat/agent-parameters` or equivalent).

---

## Changes

### Document Agent — profile context (`lib/run-document-analysis.js`)

- Loads `calculation_basis` and `notes` from `calculation_profiles` (via the documents join) instead of omitting them.
- Forwards `calculation_basis` and `profile_notes` in the payload to AgenteDocumental (`DOC_AGENT_URL`).
- Adds debug logging when profile metadata is attached to an analysis run.

### Admin document analyses — real data (`routes/admin-document-analyses.js`)

**`GET /api/admin/document-analyses`**

- Queries `document_analyses` joined with `calculation_profiles`, `countries`, `providers`, and `users_profile`.
- Returns `{ success, mock: false, items }` with: `id`, `profile_id`, `country`, `country_code`, `provider`, `provider_type`, `created_by`, `created_at`, `status`.
- On DB failure in development, falls back to mock fixtures (same behaviour as before, but only as fallback).

**`GET /api/admin/document-analyses/:id`**

- Loads full analysis row including `analysis_json`, `summary`, `guardrail_audit`.
- Maps `transaction_rules` / `rules`, `plans`, `assumptions`, `ambiguities`, and `conflicts` from `analysis_json` with safe array fallbacks.
- Returns `404` when the analysis does not exist.
- Falls back to mock detail only when the DB query fails.

### Admin users (`routes/users.js`)

**`GET /api/admin/users/:id`** (new)

- Admin-only: returns a single `users_profile` with company info and `ai_calls_this_month` (current month from `ai_usage_logs`).
- `404` if the user does not exist.

### CORS (`server.js`)

- `FRONTEND_URL` supports **comma-separated** multiple origins.
- Origin callback allows: exact match, `*`, and **wildcard patterns** (e.g. `*--planadvisor.netlify.app` for Netlify deploy previews).
- Logs blocked origins for debugging.

---

## Files changed

| File | Δ |
|------|---|
| `lib/run-document-analysis.js` | +11 |
| `routes/admin-document-analyses.js` | +193 / −20 |
| `routes/users.js` | +31 |
| `server.js` | +30 / −2 |

**4 files** · **~245 insertions, ~20 deletions** (vs `main`)

---

## Commits on this branch (vs `main`)

1. `calculation_basis` and `notes` fields passed to the Document Agent  
2. Fetch AI analysis from `document_analyses` table (list + detail)  
3. User admin actions — `GET /api/admin/users/:id`  
4. `calculation_basis` refers to correct table (`calculation_profiles`)

---

## Test plan

- [ ] **Document analysis run** — Create or use a profile with `calculation_basis` and `notes` set; upload a document and trigger analysis. Confirm agent request body includes `calculation_basis` and `profile_notes` (check API logs or agent logs).
- [ ] **`GET /api/admin/document-analyses`** — As admin, list analyses; verify real rows when DB has data; verify `mock: false` in response.
- [ ] **`GET /api/admin/document-analyses/:id`** — Open a known analysis id; verify `rules`, `plans`, `assumptions`, `guardrail_audit`, country/provider, and `created_by` populate correctly.
- [ ] **`GET /api/admin/document-analyses/:missing-id`** — Expect `404`.
- [ ] **`GET /api/admin/users/:id`** — Valid user returns profile + company + `ai_calls_this_month`; invalid id returns `404`.
- [ ] **CORS** — Call API from production frontend URL and from a Netlify preview URL (if configured in `FRONTEND_URL`); confirm preflight succeeds. Confirm unknown origin is rejected when not listed.
- [ ] **Regression** — `PATCH /api/admin/users/:id`, wizard analysis, and document upload flows still work.

---

## Deployment notes

| Variable | Notes |
|----------|--------|
| `DOC_AGENT_URL` | AgenteDocumental must accept `calculation_basis` and `profile_notes` in the analyze payload (already supported on agent side). |
| `FRONTEND_URL` | Optional: comma-separated list, e.g. `https://planadvisor.netlify.app,https://*--planadvisor.netlify.app` for previews. |

No new database migrations on this branch.

---

## Breaking changes

None expected. Document analyses responses change from always-mock to real data when the table is populated; clients should already handle `mock: true|false`.
