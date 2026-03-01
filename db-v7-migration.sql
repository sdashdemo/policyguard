-- ═══════════════════════════════════════════════════════
-- db-v7-migration.sql — ASSESS_PROMPT v7 schema changes
-- Run against Supabase before deploying v7 code
-- ═══════════════════════════════════════════════════════

-- 1. New columns on coverage_assessments for v7 response fields
ALTER TABLE coverage_assessments ADD COLUMN IF NOT EXISTS trigger_span text;
ALTER TABLE coverage_assessments ADD COLUMN IF NOT EXISTS inapplicability_reason text;
ALTER TABLE coverage_assessments ADD COLUMN IF NOT EXISTS conflict_detail text;
ALTER TABLE coverage_assessments ADD COLUMN IF NOT EXISTS reviewed_provision_refs jsonb;
ALTER TABLE coverage_assessments ADD COLUMN IF NOT EXISTS covering_policy_number text;

-- 2. Add JSONB attributes column to facility_profiles
-- This replaces the individual boolean columns (prohibits_restraint, operates_otp, etc.)
-- with a dynamic key-value model. See lib/facility-attributes.js for the registry.
ALTER TABLE facility_profiles ADD COLUMN IF NOT EXISTS attributes jsonb DEFAULT '{}';

-- 3. Backfill attributes JSONB from existing boolean columns
-- This is safe to run multiple times — it only sets keys that don't already exist.
UPDATE facility_profiles
SET attributes = COALESCE(attributes, '{}'::jsonb)
  || jsonb_build_object(
    'prohibits_restraint', COALESCE(prohibits_restraint, true),
    'operates_otp', COALESCE(operates_otp, false),
    'smoking_in_buildings', COALESCE(smoking_in_buildings_allowed, false),
    'patient_work_program', COALESCE(allows_patient_work_program, false)
  )
WHERE attributes IS NULL OR attributes = '{}'::jsonb;

-- 4. Verify backfill
-- SELECT abbreviation, state, attributes FROM facility_profiles ORDER BY state, abbreviation;

-- 5. Indexes for new status values
CREATE INDEX IF NOT EXISTS idx_ca_not_applicable
  ON coverage_assessments (map_run_id)
  WHERE status = 'NOT_APPLICABLE';

CREATE INDEX IF NOT EXISTS idx_ca_review_notes
  ON coverage_assessments (map_run_id)
  WHERE review_notes IS NOT NULL;

-- NOTE: The legacy boolean columns (prohibits_restraint, smoking_in_buildings_allowed,
-- allows_patient_work_program, operates_otp) are kept for backward compatibility.
-- The code reads from facility.attributes via the dynamic registry.
-- These columns can be dropped in a future migration once all code paths use attributes.

-- 6. Add exclude_from_assessment to obligations (skip junk/admin items)
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS exclude_from_assessment boolean DEFAULT false;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS exclude_reason text;
