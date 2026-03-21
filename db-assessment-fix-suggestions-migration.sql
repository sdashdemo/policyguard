-- ============================================================
-- Assessment fix suggestion persistence schema
-- Run in Supabase SQL Editor before deploying code that reads
-- or writes assessment_fix_suggestions.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assessment_fix_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id text NOT NULL REFERENCES coverage_assessments(id) ON DELETE CASCADE,
  policy_health_check_id uuid REFERENCES policy_health_checks(id) ON DELETE SET NULL,
  summary text NOT NULL,
  suggested_fix text NOT NULL,
  implementation_notes text,
  raw_response_json jsonb NOT NULL,
  prompt_version text NOT NULL,
  model_id text,
  generated_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_fix_suggestions_assessment_id
  ON assessment_fix_suggestions (assessment_id);

CREATE INDEX IF NOT EXISTS idx_assessment_fix_suggestions_policy_health_check_id
  ON assessment_fix_suggestions (policy_health_check_id);
