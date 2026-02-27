-- PolicyGuard v7 — Database Indexes
-- Run in Supabase SQL Editor

-- Coverage assessments (hot path for dashboard, gaps, facility views)
CREATE INDEX IF NOT EXISTS idx_ca_obligation ON coverage_assessments(obligation_id);
CREATE INDEX IF NOT EXISTS idx_ca_status ON coverage_assessments(status);
CREATE INDEX IF NOT EXISTS idx_ca_policy ON coverage_assessments(policy_id);
CREATE INDEX IF NOT EXISTS idx_ca_human ON coverage_assessments(human_status) WHERE human_status IS NOT NULL;

-- Obligations (extraction and assessment queries)
CREATE INDEX IF NOT EXISTS idx_obligations_source ON obligations(reg_source_id);

-- Policies (indexing pipeline)
CREATE INDEX IF NOT EXISTS idx_policies_indexed ON policies(indexed_at) WHERE indexed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_policies_domain ON policies(domain);

-- Provisions (matching)
CREATE INDEX IF NOT EXISTS idx_provisions_policy ON provisions(policy_id);

-- Verify
SELECT indexname, tablename FROM pg_indexes 
WHERE schemaname = 'public' AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;
