-- ============================================================
-- Policy health check cache schema
-- Run in Supabase SQL Editor before deploying code that reads
-- or writes policy_health_checks.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS policy_health_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id text NOT NULL REFERENCES coverage_assessments(id) ON DELETE CASCADE,
  policy_id text NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  summary text NOT NULL,
  findings_json jsonb NOT NULL,
  prompt_version text NOT NULL,
  model_id text,
  context_hash text,
  generated_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_health_checks_assessment_id
  ON policy_health_checks (assessment_id);

CREATE INDEX IF NOT EXISTS idx_policy_health_checks_policy_id
  ON policy_health_checks (policy_id);
