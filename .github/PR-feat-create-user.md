## Summary

Adds **admin user lifecycle APIs** (create, update, list companies) with **Supabase Auth + Railway `users_profile` sync**, and a **modify profile** endpoint to reopen active calculation profiles for document re-upload and AI re-analysis.

Pairs with PlanAdvisorFront branch `feat/create-user` (admin new-user page, user edit, modify profile, inactive login block).

**Branch:** `feat/create-user` → `main`

---

## Changes

### User creation — Supabase + Railway (`routes/users.js`)

**`POST /api/admin/users/create`** (new, preferred)

- Admin only. Creates the user in **Supabase Auth** (`auth.admin.createUser`) then inserts **`users_profile`** in PostgreSQL using the Supabase user UUID as `id`.
- Body: `email`, `password`, `full_name`, `role`, `company_id` (required when `role` is `client`).
- Auto-confirms email (`email_confirm: true`).
- **Rollback:** deletes the Supabase user if the DB insert fails.
- Requires **`SUPABASE_SERVICE_ROLE_KEY`** (returns `503` if missing).

**`POST /api/admin/users`** (legacy)

- Still supported for manual `supabase_id` + profile insert. Marked deprecated in favour of `/users/create`.

### User update — dual sync (`routes/users.js`)

**`PATCH /api/admin/users/:id`** (new)

- Admin only. Updates **Supabase Auth** (`email`, `user_metadata.full_name`, `user_metadata.role`) then **`users_profile`** (`email`, `full_name`, `role`, `company_id`, **`active`**).
- Partial updates supported (only sent fields are changed).
- Requires **`SUPABASE_SERVICE_ROLE_KEY`**.

### Companies list (`routes/users.js`)

**`GET /api/admin/companies`** (new)

- Admin only. Returns `id`, `name`, `type`, `created_at` for company dropdowns on the front end.

### Modify calculation profile (`routes/profiles.js`)

**`POST /api/admin/profiles/:id/modify`** (new)

- Admin only. Only allowed when profile `status === 'active'`.
- Sets `status = 'pending_approval'` and `active_to = CURRENT_DATE` (profile hidden from customer calculator until re-approved).
- Writes an audit log entry (`modify_profile`).
- Returns `409` with `modify_not_allowed` if the profile is not active.

### Existing endpoints (unchanged behaviour, used by front)

- **`GET /api/admin/users/:id`** — single user + company + `ai_calls_this_month`
- **`GET /api/me`** — used by front login to read `active` for any role (not admin-only)

---

## Environment variables

| Variable | Required for |
|----------|----------------|
| `SUPABASE_URL` | Auth admin client |
| `SUPABASE_ANON_KEY` | JWT validation (`requireAuth`) |
| `SUPABASE_SERVICE_ROLE_KEY` | `POST /users/create`, `PATCH /users/:id` |

---

## Files changed

| File | Δ |
|------|---|
| `routes/users.js` | +create, +patch, +companies, Supabase admin client |
| `routes/profiles.js` | +`POST /profiles/:id/modify` |

**Commits on branch (since `main`):**

- `da9e940` — Modify existing profile
- `a9a533c` — Create user at Supabase
- `8b93878` — Edit single user

---

## Test plan

- [ ] Set `SUPABASE_SERVICE_ROLE_KEY` on Railway for the API service.
- [ ] **Create user:** `POST /api/admin/users/create` with admin JWT — user appears in Supabase Dashboard → Authentication and in `users_profile`.
- [ ] **Rollback:** force a DB conflict (duplicate email) — Supabase user is removed.
- [ ] **Update user:** `PATCH /api/admin/users/:id` — change email, name, role, `active: false` — verify both Supabase and Railway.
- [ ] **Companies:** `GET /api/admin/companies` returns real UUIDs.
- [ ] **Modify profile:** on an **active** profile, `POST /api/admin/profiles/:id/modify` → `pending_approval`; repeat on same profile → `409`.
- [ ] **Inactive login:** with `active = false`, `GET /api/me` returns `403` (“Account is deactivated”) — front login should block (see PlanAdvisorFront PR).

---

## Deploy notes

- Deploy **API before or with** PlanAdvisorFront so BFF routes (`/api/pa/admin/users/create`, etc.) have backing endpoints.
- No new DB migrations in this branch (uses existing `users_profile`, `companies`, `calculation_profiles`).
