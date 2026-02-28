-- ============================================================
-- PolicyGuard Step 0 Migration: Run Scoping + Data Integrity
-- Run in Supabase SQL Editor in order
-- ============================================================

-- ============================================================
-- STEP 0: PRE-FLIGHT CHECKS — run these first and inspect output
-- If either returns rows, you have duplicates that must be resolved
-- before the unique indexes can be created.
-- ============================================================

-- Check A: duplicate assessments per run+facility+obligation
SELECT map_run_id, COALESCE(facility_id, '__org__') as facility_key,
       obligation_id, count(*) as dupes
FROM coverage_assessments
GROUP BY 1, 2, 3
HAVING count(*) > 1;

-- Check B: duplicate obligations per source+citation+requirement
SELECT reg_source_id, citation, md5(requirement) as req_hash, count(*) as dupes
FROM obligations
GROUP BY 1, 2, 3
HAVING count(*) > 1;

-- Check C: how many distinct map_run_ids exist?
SELECT map_run_id, count(*) as assessments
FROM coverage_assessments
GROUP BY map_run_id
ORDER BY count(*) DESC;

-- ============================================================
-- If checks return NO duplicates, proceed below.
-- If Check A has dupes: delete the older duplicate per group:
--   DELETE FROM coverage_assessments WHERE id IN (
--     SELECT id FROM (
--       SELECT id, ROW_NUMBER() OVER (
--         PARTITION BY map_run_id, COALESCE(facility_id,'__org__'), obligation_id
--         ORDER BY created_at DESC
--       ) as rn FROM coverage_assessments
--     ) sub WHERE rn > 1
--   );
-- If Check B has dupes: delete the older duplicate per group:
--   DELETE FROM obligations WHERE id IN (
--     SELECT id FROM (
--       SELECT id, ROW_NUMBER() OVER (
--         PARTITION BY reg_source_id, citation, md5(requirement)
--         ORDER BY created_at DESC
--       ) as rn FROM obligations
--     ) sub WHERE rn > 1
--   );
-- ============================================================


-- ============================================================
-- STEP 1: BACKFILL — create map_runs record for existing baseline
-- ============================================================

DO $$
DECLARE
  v_run_id TEXT;
  v_count INT;
  v_covered INT;
  v_partial INT;
  v_gaps INT;
  v_conflicting INT;
BEGIN
  -- Get the most common map_run_id (should be the FL baseline)
  SELECT map_run_id, count(*) INTO v_run_id, v_count
  FROM coverage_assessments
  WHERE map_run_id IS NOT NULL
  GROUP BY map_run_id
  ORDER BY count(*) DESC
  LIMIT 1;

  IF v_run_id IS NOT NULL THEN
    SELECT
      count(*) FILTER (WHERE status = 'COVERED'),
      count(*) FILTER (WHERE status = 'PARTIAL'),
      count(*) FILTER (WHERE status = 'GAP'),
      count(*) FILTER (WHERE status = 'CONFLICTING')
    INTO v_covered, v_partial, v_gaps, v_conflicting
    FROM coverage_assessments
    WHERE map_run_id = v_run_id;

    INSERT INTO map_runs (id, org_id, state, scope, total_obligations,
      covered, partial, gaps, model_id, prompt_version, started_at, completed_at)
    VALUES (
      v_run_id, 'ars', 'FL', 'baseline',
      v_count, v_covered, v_partial, v_gaps,
      'claude-sonnet-4-20250514', 'assess_v6.0',
      (SELECT min(created_at) FROM coverage_assessments WHERE map_run_id = v_run_id),
      (SELECT max(created_at) FROM coverage_assessments WHERE map_run_id = v_run_id)
    )
    ON CONFLICT (id) DO NOTHING;

    RAISE NOTICE 'Backfilled map_runs record: % with % assessments (C:% P:% G:% X:%)',
      v_run_id, v_count, v_covered, v_partial, v_gaps, v_conflicting;
  ELSE
    RAISE NOTICE 'No map_run_id found — nothing to backfill';
  END IF;
END $$;

-- Assign any orphaned assessments to the baseline run
UPDATE coverage_assessments
SET map_run_id = (
  SELECT map_run_id FROM coverage_assessments
  WHERE map_run_id IS NOT NULL
  GROUP BY map_run_id ORDER BY count(*) DESC LIMIT 1
)
WHERE map_run_id IS NULL;


-- ============================================================
-- STEP 2: SCHEMA ADDITIONS
-- ============================================================

-- Add columns to map_runs
ALTER TABLE map_runs ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE map_runs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
ALTER TABLE map_runs ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Label the baseline run
UPDATE map_runs SET label = 'FL Baseline v1', status = 'completed'
WHERE id = (
  SELECT map_run_id FROM coverage_assessments
  GROUP BY map_run_id ORDER BY count(*) DESC LIMIT 1
);


-- ============================================================
-- STEP 3: UNIQUE CONSTRAINTS (will fail if pre-flight found dupes)
-- ============================================================

-- One assessment per obligation per run per facility
CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_run_facility_obligation
ON coverage_assessments (map_run_id, COALESCE(facility_id, '__org__'), obligation_id);

-- Prevent duplicate obligation extractions
CREATE UNIQUE INDEX IF NOT EXISTS uq_obligation_source_citation
ON obligations (reg_source_id, citation, md5(requirement));


-- ============================================================
-- STEP 4: GENERATED COLUMN + INDEXES
-- ============================================================

-- effective_status = COALESCE(human_status, status) — always available
ALTER TABLE coverage_assessments
ADD COLUMN IF NOT EXISTS effective_status TEXT
GENERATED ALWAYS AS (COALESCE(human_status, status)) STORED;

-- Run-scoped query indexes
CREATE INDEX IF NOT EXISTS idx_ca_run_id ON coverage_assessments (map_run_id);
CREATE INDEX IF NOT EXISTS idx_ca_run_status ON coverage_assessments (map_run_id, status);
CREATE INDEX IF NOT EXISTS idx_ca_run_effective ON coverage_assessments (map_run_id, effective_status);


-- ============================================================
-- STEP 5: VERIFY
-- ============================================================

SELECT 'map_runs records' as check_name, count(*)::text as value FROM map_runs
UNION ALL
SELECT 'assessments with run_id', count(*)::text FROM coverage_assessments WHERE map_run_id IS NOT NULL
UNION ALL
SELECT 'assessments without run_id', count(*)::text FROM coverage_assessments WHERE map_run_id IS NULL
UNION ALL
SELECT 'distinct run_ids', count(DISTINCT map_run_id)::text FROM coverage_assessments
UNION ALL
SELECT 'baseline run label', label FROM map_runs ORDER BY created_at DESC LIMIT 1;
