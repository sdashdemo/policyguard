-- PolicyGuard Accuracy Spot-Check: Stratified Sample
-- Run this in Supabase SQL Editor to get 35 assessments for manual review
-- 10 COVERED, 10 PARTIAL, 10 GAP, 5 CONFLICTING (or all if fewer)

WITH sample AS (
  -- 10 random COVERED
  (SELECT ca.id as assessment_id, ca.status, ca.confidence, ca.gap_detail, ca.reasoning,
          ca.match_method, ca.match_score, ca.covering_policy_number,
          o.citation, o.requirement,
          rs.name as source_name,
          p.policy_number, p.title as policy_title,
          'COVERED' as sample_group
   FROM coverage_assessments ca
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE ca.status = 'COVERED'
   ORDER BY random() LIMIT 10)

  UNION ALL

  -- 10 random PARTIAL
  (SELECT ca.id, ca.status, ca.confidence, ca.gap_detail, ca.reasoning,
          ca.match_method, ca.match_score, ca.covering_policy_number,
          o.citation, o.requirement,
          rs.name as source_name,
          p.policy_number, p.title,
          'PARTIAL'
   FROM coverage_assessments ca
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE ca.status = 'PARTIAL'
   ORDER BY random() LIMIT 10)

  UNION ALL

  -- 10 random GAP
  (SELECT ca.id, ca.status, ca.confidence, ca.gap_detail, ca.reasoning,
          ca.match_method, ca.match_score, ca.covering_policy_number,
          o.citation, o.requirement,
          rs.name as source_name,
          p.policy_number, p.title,
          'GAP'
   FROM coverage_assessments ca
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE ca.status = 'GAP'
   ORDER BY random() LIMIT 10)

  UNION ALL

  -- 5 random CONFLICTING
  (SELECT ca.id, ca.status, ca.confidence, ca.gap_detail, ca.reasoning,
          ca.match_method, ca.match_score, ca.covering_policy_number,
          o.citation, o.requirement,
          rs.name as source_name,
          p.policy_number, p.title,
          'CONFLICTING'
   FROM coverage_assessments ca
   JOIN obligations o ON ca.obligation_id = o.id
   JOIN reg_sources rs ON o.reg_source_id = rs.id
   LEFT JOIN policies p ON ca.policy_id = p.id
   WHERE ca.status = 'CONFLICTING'
   ORDER BY random() LIMIT 5)
)
SELECT
  sample_group,
  citation,
  requirement,
  source_name,
  status,
  confidence,
  policy_number,
  policy_title,
  gap_detail,
  reasoning,
  match_method,
  match_score
FROM sample
ORDER BY sample_group, citation;
