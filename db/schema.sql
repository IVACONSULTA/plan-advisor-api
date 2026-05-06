-- ============================================================
-- PA Plan Advisor — PostgreSQL Schema
-- Railway PostgreSQL — 13 tables (§7.1 – §7.13 of the guide)
-- Run this once against the Railway PostgreSQL service.
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── 7.2 companies ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('internal', 'client')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.1 users_profile ──────────────────────────────────────────────────────
-- id mirrors auth.users.id from Supabase Auth
CREATE TABLE IF NOT EXISTS users_profile (
  id         UUID PRIMARY KEY,  -- = Supabase auth.users.id
  email      TEXT NOT NULL UNIQUE,
  full_name  TEXT,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'internal', 'client')),
  company_id UUID REFERENCES companies(id),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.3 countries ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS countries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT NOT NULL UNIQUE,  -- ISO 3166-1 alpha-2 e.g. 'FR'
  name       TEXT NOT NULL,
  created_by UUID REFERENCES users_profile(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.4 providers ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,  -- 'PA' | 'PDP'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.5 calculation_profiles ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calculation_profiles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id        UUID NOT NULL REFERENCES countries(id),
  provider_id       UUID NOT NULL REFERENCES providers(id),
  version           TEXT NOT NULL,
  currency          TEXT NOT NULL,  -- e.g. 'EUR'
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_approval','active','archived')),
  calculation_basis TEXT NOT NULL DEFAULT 'PA transactions',
  active_from       DATE,
  active_to         DATE,
  created_by        UUID REFERENCES users_profile(id),
  approved_by       UUID REFERENCES users_profile(id),
  approved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (country_id, provider_id, version)
);

-- ─── 7.9 documents ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id       UUID NOT NULL REFERENCES countries(id),
  provider_id      UUID NOT NULL REFERENCES providers(id),
  profile_id       UUID REFERENCES calculation_profiles(id),
  filename         TEXT NOT NULL,
  storage_path     TEXT NOT NULL,  -- NEVER exposed in API responses
  document_type    TEXT NOT NULL
                     CHECK (document_type IN (
                       'provider_pricing','transaction_guide','country_legal',
                       'contract','commercial_confirmation','other'
                     )),
  description      TEXT,
  copyright_status TEXT NOT NULL DEFAULT 'pending'
                     CHECK (copyright_status IN ('pending','clear','restricted','blocked')),
  copyright_reason TEXT,
  uploaded_by      UUID NOT NULL REFERENCES users_profile(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.6 transaction_rules ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transaction_rules (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               UUID NOT NULL REFERENCES calculation_profiles(id) ON DELETE CASCADE,
  input_key                TEXT NOT NULL,   -- e.g. 'issued_einvoicing'
  label                    TEXT NOT NULL,
  direction                TEXT,            -- 'Issued' | 'Received'
  obligation               TEXT,            -- 'E-invoicing' | 'E-reporting' | 'Payment e-reporting'
  operation_group          TEXT,
  pa_transactions_per_item NUMERIC NOT NULL,
  reason                   TEXT,
  source_document_id       UUID REFERENCES documents(id),
  source_excerpt           TEXT,
  confidence               TEXT DEFAULT 'medium'
                             CHECK (confidence IN ('high','medium','low')),
  status                   TEXT NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed','approved','rejected','pending_confirmation')),
  ai_proposed_value        JSONB,
  manually_edited          BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by              UUID REFERENCES users_profile(id),
  approved_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, input_key)
);

-- ─── 7.7 plans ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id               UUID NOT NULL REFERENCES calculation_profiles(id) ON DELETE CASCADE,
  plan_name                TEXT NOT NULL,
  included_pa_transactions NUMERIC NOT NULL,
  annual_fee               NUMERIC NOT NULL,
  monthly_fee              NUMERIC,
  extra_transaction_cost   NUMERIC NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed','approved','rejected')),
  source_document_id       UUID REFERENCES documents(id),
  source_excerpt           TEXT,
  confidence               TEXT DEFAULT 'medium'
                             CHECK (confidence IN ('high','medium','low')),
  approved_by              UUID REFERENCES users_profile(id),
  approved_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.8 assumptions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assumptions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         UUID NOT NULL REFERENCES calculation_profiles(id) ON DELETE CASCADE,
  key                TEXT NOT NULL,
  value              TEXT NOT NULL,
  reason             TEXT,
  status             TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed','approved','rejected','pending_confirmation')),
  source_document_id UUID REFERENCES documents(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.10 document_analyses ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_analyses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      UUID NOT NULL REFERENCES calculation_profiles(id),
  document_ids    UUID[] NOT NULL,
  analysis_json   JSONB NOT NULL,
  summary         TEXT,
  status          TEXT NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('completed','failed','pending_review')),
  guardrail_audit JSONB NOT NULL DEFAULT '{}',
  created_by      UUID NOT NULL REFERENCES users_profile(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.11 scenarios ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scenarios (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID REFERENCES companies(id),
  client_name         TEXT,
  profile_id          UUID NOT NULL REFERENCES calculation_profiles(id),
  input_json          JSONB NOT NULL,
  result_json         JSONB NOT NULL,
  recommended_plan_id UUID REFERENCES plans(id),
  ai_summary          TEXT,
  created_by          UUID NOT NULL REFERENCES users_profile(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.12 ai_usage_logs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users_profile(id),
  action         TEXT NOT NULL,   -- 'document_analysis' | 'generate_summary' | 're_analyze_document'
  model          TEXT NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  estimated_cost NUMERIC,
  document_id    UUID REFERENCES documents(id),
  scenario_id    UUID REFERENCES scenarios(id),
  processing_id  TEXT,            -- from EU AI Act guardrail audit
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── 7.13 audit_logs ────────────────────────────────────────────────────────
-- Immutable. No UPDATE or DELETE should ever run against this table.
CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users_profile(id),
  action      TEXT NOT NULL,       -- 'approve_rule' | 'edit_plan' | 'activate_profile' | etc.
  entity_type TEXT NOT NULL,       -- 'transaction_rule' | 'plan' | 'assumption' | 'calculation_profile'
  entity_id   UUID NOT NULL,
  before_json JSONB,
  after_json  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transaction_rules_profile  ON transaction_rules(profile_id);
CREATE INDEX IF NOT EXISTS idx_transaction_rules_status   ON transaction_rules(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_plans_profile              ON plans(profile_id);
CREATE INDEX IF NOT EXISTS idx_plans_status               ON plans(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_scenarios_created_by       ON scenarios(created_by);
CREATE INDEX IF NOT EXISTS idx_scenarios_company          ON scenarios(company_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_profile          ON scenarios(profile_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_user_month   ON ai_usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_profile          ON documents(profile_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity          ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_calc_profiles_status       ON calculation_profiles(status);
CREATE INDEX IF NOT EXISTS idx_calc_profiles_country_prov ON calculation_profiles(country_id, provider_id);
