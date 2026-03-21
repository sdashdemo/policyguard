-- ============================================================
-- Assessment policy link schema
-- Run in Supabase SQL Editor before executing the Iteration 2
-- backfill or deploying code that reads assessment_policy_links.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assessment_policy_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id text NOT NULL REFERENCES coverage_assessments(id) ON DELETE CASCADE,
  policy_id text NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  link_basis text NOT NULL,
  linked_by text,
  note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT assessment_policy_links_link_basis_check
    CHECK (link_basis IN ('covering_policy_number_backfill', 'reviewer_selected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_policy_links_assessment_id
  ON assessment_policy_links (assessment_id);

CREATE INDEX IF NOT EXISTS idx_assessment_policy_links_policy_id
  ON assessment_policy_links (policy_id);
