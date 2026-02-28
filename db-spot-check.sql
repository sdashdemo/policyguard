-- PolicyGuard Accuracy Spot-Check: Stratified Sample (Run-Scoped)
-- Run AFTER the Step 0 migration

-- First: verify you have a baseline run
-- SELECT id, label, status, total_obligations FROM map_runs ORDER BY created_at DESC;

WITH latest_run AS (
  SELECT id FROM map_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1
),
sample AS (
  -- 10 random COVERED
  (SELECT ca.id as assessment_id,
          COALESCE(ca.human_status, ca.status) as effective_status,
          ca.status as llm_status, ca.confidence, ca.gap_detail, ca.reasoning,
          ca.match_method, ca.match_score, ca.recommended_policy,
          ca.obligation_span, ca.provision_span,
          o.citation, o.requirement, o.risk_tier,
          rs.name as source_name,
          p.policy_number, p.title as policy_title,
          'COVERED' as sample_group
   FROM coverage_assessments ca
   JOIN latest_run lr ON ca.map_run_id = lr.id
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE COALESCE(ca.human_status, ca.status) = 'COVERED'
   ORDER BY random() LIMIT 10)

  UNION ALL

  -- 10 random PARTIAL
  (SELECT ca.id,
          COALESCE(ca.human_status, ca.status), ca.status, ca.confidence,
          ca.gap_detail, ca.reasoning, ca.match_method, ca.match_score,
          ca.recommended_policy, ca.obligation_span, ca.provision_span,
          o.citation, o.requirement, o.risk_tier,
          rs.name, p.policy_number, p.title,
          'PARTIAL'
   FROM coverage_assessments ca
   JOIN latest_run lr ON ca.map_run_id = lr.id
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE COALESCE(ca.human_status, ca.status) = 'PARTIAL'
   ORDER BY random() LIMIT 10)

  UNION ALL

  -- 10 random GAP
  (SELECT ca.id,
          COALESCE(ca.human_status, ca.status), ca.status, ca.confidence,
          ca.gap_detail, ca.reasoning, ca.match_method, ca.match_score,
          ca.recommended_policy, ca.obligation_span, ca.provision_span,
          o.citation, o.requirement, o.risk_tier,
          rs.name, p.policy_number, p.title,
          'GAP'
   FROM coverage_assessments ca
   JOIN latest_run lr ON ca.map_run_id = lr.id
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE COALESCE(ca.human_status, ca.status) = 'GAP'
   ORDER BY random() LIMIT 10)

  UNION ALL

  -- 5 random CONFLICTING
  (SELECT ca.id,
          COALESCE(ca.human_status, ca.status), ca.status, ca.confidence,
          ca.gap_detail, ca.reasoning, ca.match_method, ca.match_score,
          ca.recommended_policy, ca.obligation_span, ca.provision_span,
          o.citation, o.requirement, o.risk_tier,
          rs.name, p.policy_number, p.title,
          'CONFLICTING'
   FROM coverage_assessments ca
   JOIN latest_run lr ON ca.map_run_id = lr.id
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE COALESCE(ca.human_status, ca.status) = 'CONFLICTING'
   ORDER BY random() LIMIT 5)
)
SELECT
  sample_group,
  citation,
  requirement,
  source_name,
  risk_tier,
  effective_status,
  llm_status,
  confidence,
  policy_number,
  policy_title,
  recommended_policy,
  gap_detail,
  reasoning,
  match_method,
  match_score,
  obligation_span,
  provision_span
FROM sample
ORDER BY sample_group, citation;
