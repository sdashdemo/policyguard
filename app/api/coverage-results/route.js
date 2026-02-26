import { db } from '@/lib/db';
import { coverageAssessments, obligations, policies, mapRuns } from '@/lib/schema';
import { eq, desc, and, sql } from 'drizzle-orm';

const ORG_ID = 'ars';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get('run_id');
    const status = searchParams.get('status');
    const domain = searchParams.get('domain');

    // Get all assessments with obligation and policy details
    let query = sql`
      SELECT 
        ca.id,
        ca.status,
        ca.confidence,
        ca.gap_detail,
        ca.recommended_policy,
        ca.match_method,
        ca.match_score,
        ca.map_run_id,
        ca.assessed_by,
        ca.created_at,
        o.citation,
        o.requirement,
        o.topics,
        o.source_type,
        o.reg_source_id,
        p.policy_number as covering_policy_number,
        p.title as covering_policy_title,
        p.domain as covering_policy_domain
      FROM coverage_assessments ca
      JOIN obligations o ON ca.obligation_id = o.id
      LEFT JOIN policies p ON ca.policy_id = p.id
      WHERE ca.org_id = ${ORG_ID}
    `;

    if (runId) {
      query = sql`${query} AND ca.map_run_id = ${runId}`;
    }
    if (status) {
      query = sql`${query} AND ca.status = ${status}`;
    }
    if (domain) {
      query = sql`${query} AND p.domain = ${domain}`;
    }

    query = sql`${query} ORDER BY ca.created_at DESC`;

    const rows = await db.execute(query);

    // Summary stats
    const summary = { total: 0, covered: 0, partial: 0, gap: 0, error: 0 };
    for (const row of rows) {
      summary.total++;
      const s = (row.status || '').toLowerCase();
      if (s === 'covered') summary.covered++;
      else if (s === 'partial') summary.partial++;
      else if (s === 'gap') summary.gap++;
      else summary.error++;
    }

    return Response.json({ assessments: rows, summary });

  } catch (err) {
    console.error('Results error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST: get unassessed obligation IDs (for batch runner)
export async function POST(req) {
  try {
    const body = await req.json();
    const { run_id, domain, source_id, limit } = body;

    // Get all obligation IDs
    let oblQuery = sql`SELECT id FROM obligations`;
    if (source_id) {
      oblQuery = sql`${oblQuery} WHERE reg_source_id = ${source_id}`;
    }
    const allObls = await db.execute(oblQuery);
    const allOblIds = allObls.map(r => r.id);

    // Get already-assessed obligation IDs for this run
    let assessedIds = new Set();
    if (run_id) {
      const assessed = await db.execute(
        sql`SELECT obligation_id FROM coverage_assessments WHERE map_run_id = ${run_id}`
      );
      assessedIds = new Set(assessed.map(r => r.obligation_id));
    }

    // Filter to unassessed
    const unassessed = allOblIds.filter(id => !assessedIds.has(id));
    const batch = limit ? unassessed.slice(0, limit) : unassessed;

    return Response.json({
      total_obligations: allOblIds.length,
      already_assessed: assessedIds.size,
      remaining: unassessed.length,
      batch,
    });

  } catch (err) {
    console.error('Unassessed error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
