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

-- 2. Update effective_status generated column to include NOT_APPLICABLE
-- (The existing generated column already uses COALESCE(human_status, status)
--  which will automatically work with any status value including NOT_APPLICABLE.
--  No change needed — this is a confirmation note.)

-- 3. Ensure the review route accepts NOT_APPLICABLE as a valid human_status
-- (Already handled in code — review/route.js line 14 already includes NOT_APPLICABLE)

-- 4. Add indexes for the new status values (optional, for query performance)
CREATE INDEX IF NOT EXISTS idx_ca_not_applicable
  ON coverage_assessments (map_run_id)
  WHERE status = 'NOT_APPLICABLE';

CREATE INDEX IF NOT EXISTS idx_ca_review_notes
  ON coverage_assessments (map_run_id)
  WHERE review_notes IS NOT NULL;

-- 5. Verify facility toggle columns exist (from Part 2 of db-pre-implementation.sql)
-- These should already exist — this is idempotent
ALTER TABLE facility_profiles ADD COLUMN IF NOT EXISTS smoking_in_buildings_allowed boolean;
ALTER TABLE facility_profiles ADD COLUMN IF NOT EXISTS allows_patient_work_program boolean;
ALTER TABLE facility_profiles ADD COLUMN IF NOT EXISTS operates_otp boolean;

-- 6. Set facility toggle values for FL facilities
-- IMPORTANT: Review these values with Sam before executing.
-- All ARS FL facilities prohibit restraint, prohibit smoking in buildings,
-- do not have patient work programs. OTP status per facility:
-- ORC, TRV, RVPB are OTP facilities (no methadone per briefing).

-- Example (update facility IDs to match actual data):
-- UPDATE facility_profiles SET
--   smoking_in_buildings_allowed = false,
--   allows_patient_work_program = false,
--   operates_otp = true,
--   prohibits_restraint = true
-- WHERE abbreviation IN ('ORC', 'TRV', 'RVPB');

-- UPDATE facility_profiles SET
--   smoking_in_buildings_allowed = false,
--   allows_patient_work_program = false,
--   operates_otp = false,
--   prohibits_restraint = true
-- WHERE abbreviation IN ('RVA', 'RVSA', 'RVCH')
--   OR abbreviation NOT IN ('ORC', 'TRV', 'RVPB');
