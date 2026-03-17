-- ============================================================
-- Assessment review + defect tracking schema
-- Run in Supabase SQL Editor before deploying code that uses
-- assessment_reviews or system_defects.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assessment_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id text NOT NULL REFERENCES coverage_assessments(id) ON DELETE CASCADE,
  disposition text NOT NULL DEFAULT 'unreviewed',
  override_status text,
  note text,
  dismiss_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT assessment_reviews_disposition_check
    CHECK (disposition IN ('unreviewed', 'confirmed', 'overridden', 'flagged_engine_defect', 'dismissed')),
  CONSTRAINT assessment_reviews_override_status_check
    CHECK (override_status IN ('COVERED', 'PARTIAL', 'GAP', 'CONFLICTING', 'NOT_APPLICABLE', 'REVIEW_NEEDED', 'NEEDS_LEGAL_REVIEW'))
);

CREATE TABLE IF NOT EXISTS system_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id text NOT NULL REFERENCES coverage_assessments(id) ON DELETE CASCADE,
  defect_class text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  severity text NOT NULL DEFAULT 'medium',
  seeded_from text,
  note text,
  owner text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT system_defects_defect_class_check
    CHECK (defect_class IN ('packet', 'neighbor_drift', 'applicability', 'retrieval', 'citation_extraction', 'json_parse', 'admin_boundary', 'other')),
  CONSTRAINT system_defects_status_check
    CHECK (status IN ('open', 'acknowledged', 'fixed', 'wont_fix')),
  CONSTRAINT system_defects_severity_check
    CHECK (severity IN ('low', 'medium', 'high'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_reviews_assessment_id
  ON assessment_reviews (assessment_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_system_defects_assessment_id
  ON system_defects (assessment_id);
