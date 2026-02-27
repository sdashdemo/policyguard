import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const state = searchParams.get('state');
    const sourceId = searchParams.get('source_id');
    const humanReviewed = searchParams.get('human_reviewed');

    const results = await db.execute(sql`
      SELECT 
        o.id as obligation_id,
        o.citation,
        o.requirement,
        o.source_type,
        o.topics,
        o.levels_of_care,
        o.responsible_party,
        o.timeframe,
        o.documentation_required,
        rs.id as source_id,
        rs.name as source_name,
        rs.state as source_state,
        ca.id as assessment_id,
        ca.status,
        ca.confidence,
        ca.gap_detail,
        ca.recommended_policy,
        ca.policy_id,
        ca.match_method,
        ca.match_score,
        ca.assessed_by,
        ca.human_status,
        ca.reviewed_by,
        ca.reviewed_at,
        ca.review_notes,
        p.policy_number,
        p.title as policy_title,
        p.domain as policy_domain
      FROM obligations o
      JOIN reg_sources rs ON o.reg_source_id = rs.id
      LEFT JOIN coverage_assessments ca ON ca.obligation_id = o.id
      LEFT JOIN policies p ON ca.policy_id = p.id
      ORDER BY rs.name, o.citation
    `);

    let rows = results.rows || results || [];

    if (status && status !== 'all') {
      if (status === 'UNASSESSED') {
        rows = rows.filter(r => !r.status);
      } else {
        rows = rows.filter(r => r.status === status);
      }
    }
    if (state && state !== 'all') {
      rows = rows.filter(r => r.source_state === state || !r.source_state || r.source_state === 'ALL');
    }
    if (sourceId && sourceId !== 'all') {
      rows = rows.filter(r => r.source_id === sourceId);
    }
    if (humanReviewed === 'true') {
      rows = rows.filter(r => r.human_status);
    } else if (humanReviewed === 'false') {
      rows = rows.filter(r => !r.human_status && r.assessment_id);
    }

    const summary = {
      total: rows.length,
      covered: rows.filter(r => r.status === 'COVERED').length,
      partial: rows.filter(r => r.status === 'PARTIAL').length,
      gap: rows.filter(r => r.status === 'GAP').length,
      unassessed: rows.filter(r => !r.status).length,
      human_reviewed: rows.filter(r => r.human_status).length,
    };

    return Response.json({ rows, summary });
  } catch (err) {
    console.error('Gaps error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
