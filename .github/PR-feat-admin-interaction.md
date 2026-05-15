## 📝 Description

Expands the Plan Advisor API to support the full **admin wizard workflow**: document upload and storage, copyright clearance, Document Agent analysis, AI-assisted rule/plan extraction, and admin approval flows for transaction rules and plans. Adds orchestration for long-running agent calls (async jobs, longer timeouts, JSON parsing) and aligns deployment with Railway (Node 22, S3/volume storage, env naming).

## 🎯 What does this PR do?

- [x] Feature addition
- [ ] Bug fix
- [x] Documentation update
- [ ] Code refactoring
- [ ] Other: **\*\*\*\***

## 🔍 Changes Made

### Admin wizard & documents
- **Document upload API** — multipart uploads (PDF, DOCX, XLSX, CSV, TXT, MD) with multer; files stored via `lib/storage.js` (Railway S3 bucket or volume fallback).
- **Staging & profile linking** — documents can live in staging before a calculation profile exists; promotion/linking when the profile is created; simplified flow to persist directly to permanent storage where applicable.
- **Copyright clearance** — `lib/copyright-checker.js` and `POST /api/admin/documents/copyright-check`; blocks uploads when the document **explicitly prohibits AI processing** (HTTP 451).
- **Inline text extraction** — API extracts document text (`lib/document-text-extract.js`, `pdf-parse`) and sends it to the Document Agent instead of relying only on agent-side file reads.

### Document Agent & analysis orchestration
- **`lib/run-document-analysis.js`** — central flow to call the doc agent, persist `document_analyses`, and map results to DB.
- **`scripts/parse_nested_output.py`** — normalizes nested agent output to JSON for rules/plans.
- **Wizard routes** (`routes/wizard-analysis.js`):
  - `POST /api/admin/wizard/run-analysis`
  - `GET /api/admin/wizard/analysis-status`
  - `POST /api/admin/wizard/approve-analysis`
- **AI analysis chat** (`routes/ai-analysis-chat.js`) — async in-memory jobs for long runs (Netlify/Railway timeouts); predefined initial message; approval endpoint for AI analysis results.
- Increased agent timeouts; API waits for agent completion; debug logging for analysis persistence.

### Rules, plans & profiles (admin CRUD)
- **Transaction rules** (`routes/rules.js`): `GET /api/admin/transaction-rules?profile_id=`, patch, approve, reject, **delete** single rule.
- **Plans** (`routes/plans.js`): list by profile, patch, approve, reject, delete — supports wizard step 4 plan approval.
- **Profiles** (`routes/profiles.js`): always creates a **fresh draft** profile (fixes documents attaching to wrong active profile); activate, delete inactive profiles; `profile_id` included in document analysis responses.

### Admin & platform
- **Admin dashboard** — `GET /api/admin/dashboard`.
- **Document analyses listing** — `routes/admin-document-analyses.js` (+ mock helper for dev).
- **Health** — storage mount/writable status and agent URL availability in `GET /health`.
- **Calculator** — minor updates for profile/rule counts.

### Database & seeds
- **Migrations** `001`–`006`: document staging, unique constraints, nullable document FKs during wizard, transaction rules index, `document_analyses` running status, assumptions unique per profile key.
- **Schema** updates for documents, analyses, and related tables.
- **Seeds** — France B2B router v2 data and profile cleanup scripts.

### Infrastructure & docs
- **Node 22** upgrade (`Dockerfile`, `nixpacks.toml`).
- **Storage env** aligned with Railway naming (`S3_BUCKET_NAME`, `AWS_*`, `DOCUMENTS_PATH`).
- **`.env.example`** and **`docs/API-USER-ENDPOINTS.md`** updated for new admin endpoints and env vars.
- **Dependencies** — `pdf-parse`, `multer`, storage SDK updates; `scripts/verify-pdf-parse.js` for deploy checks.

## 🧪 Testing

- [ ] I have tested this locally
- [ ] All tests pass
- [ ] No breaking changes

**Suggested manual checks:**
- [ ] Upload document → copyright check (clear + blocked sample) → persist and list by profile
- [ ] Run wizard analysis → poll `analysis-status` → approve analysis
- [ ] AI analysis chat: start job → poll → approve; verify rules/plans in DB
- [ ] CRUD transaction rules and plans (approve/reject/delete)
- [ ] Create draft profile → upload docs → activate profile → delete inactive draft
- [ ] `GET /health` shows DB + storage + agent flags on Railway
- [ ] Run DB migrations `001`–`006` on target Postgres before deploy

## 📸 Screenshots (if applicable)

N/A — API-only PR (UI changes live in PlanAdvisorFront).

## 📋 Checklist

- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Code is commented where necessary
- [ ] Documentation updated (if needed)

## 🚀 Deployment Notes

**Run migrations** on Railway Postgres before or during deploy:

```bash
# Apply in order: db/migrations/001_*.sql … 006_*.sql
```

**Env vars** (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Required |
| `PA_PLAN_API_KEY` | Required in production (`X-API-Key` on all `/api/*` except `/live`, `/health`) |
| `DOC_AGENT_URL`, `SUMMARY_AGENT_URL`, `AGENT_API_KEY` | Document/summary agents |
| `DOC_AGENT_TIMEOUT_MS` | Optional; default ~290s |
| `S3_BUCKET_NAME` + `AWS_*` or `DOCUMENTS_PATH` | Document storage |
| `FRONTEND_URL` | CORS |

**Node 22** — ensure Railway/build image matches `Dockerfile` / `nixpacks.toml`.

**Optional:** `PA_UPLOAD_DEBUG=1`, `DOC_AGENT_LOG_RESPONSE=true` for troubleshooting uploads/analysis.

## 📞 Additional Notes

- **Breaking / behavioral:** `POST /api/admin/profiles` no longer reuses an existing country+provider profile; it always creates a new draft so wizard uploads stay isolated.
- **Copyright policy:** only **explicit** AI-processing prohibitions block ingestion; absence of prohibition → clear.
- **Mock data:** admin document analyses mock is skipped on Railway when files are missing (see commit around mock loading fix).
- **Related repos:** pairs with PlanAdvisorFront admin wizard / AI analysis UI on the same feature branch.
