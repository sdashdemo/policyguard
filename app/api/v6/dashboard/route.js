import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req?.url || 'http://localhost');
    const runId = searchParams.get('run_id');

    // Resolve run
    let effectiveRunId = runId;
    if (!effectiveRunId) {
      const latest = await db.execute(sql`
        SELECT id FROM map_runs ORDER BY (status = 'completed') DESC, started_at DESC LIMIT 1
      `);
      effectiveRunId = (latest.rows || latest)?.[0]?.id || null;
    }

    // Facilities (from view)
    const facilities = await db.execute(sql`
      SELECT * FROM v_facility_coverage ORDER BY state, name
    `);

    // Sources (from view)
    const sources = await db.execute(sql`
      SELECT * FROM v_source_coverage ORDER BY state NULLS LAST, name
    `);

    // Run-scoped stats
    let stats;
    if (effectiveRunId) {
      stats = await db.execute(sql`
        SELECT
          (SELECT count(*) FROM obligations) as total_obligations,
          (SELECT count(DISTINCT ca.obligation_id) FROM coverage_assessments ca WHERE ca.map_run_id = ${effectiveRunId}) as total_assessed,
          (SELECT count(*) FROM coverage_assessments ca WHERE ca.map_run_id = ${effectiveRunId} AND COALESCE(ca.human_status, ca.status) = 'COVERED') as covered,
          (SELECT count(*) FROM coverage_assessments ca WHERE ca.map_run_id = ${effectiveRunId} AND COALESCE(ca.human_status, ca.status) = 'PARTIAL') as partial,
          (SELECT count(*) FROM coverage_assessments ca WHERE ca.map_run_id = ${effectiveRunId} AND COALESCE(ca.human_status, ca.status) = 'GAP') as gaps,
          (SELECT count(*) FROM coverage_assessments ca WHERE ca.map_run_id = ${effectiveRunId} AND ca.human_status IS NOT NULL) as human_reviewed,
          (SELECT count(*) FROM policies) as total_policies,
          (SELECT count(*) FROM provisions) as total_provisions,
          (SELECT count(*) FROM reg_sources) as total_sources
      `);
    } else {
      stats = await db.execute(sql`
        SELECT
          (SELECT count(*) FROM obligations) as total_obligations,
          (SELECT count(*) FROM coverage_assessments) as total_assessed,
          (SELECT count(*) FROM coverage_assessments WHERE COALESCE(human_status, status) = 'COVERED') as covered,
          (SELECT count(*) FROM coverage_assessments WHERE COALESCE(human_status, status) = 'PARTIAL') as partial,
          (SELECT count(*) FROM coverage_assessments WHERE COALESCE(human_status, status) = 'GAP') as gaps,
          (SELECT count(*) FROM coverage_assessments WHERE human_status IS NOT NULL) as human_reviewed,
          (SELECT count(*) FROM policies) as total_policies,
          (SELECT count(*) FROM provisions) as total_provisions,
          (SELECT count(*) FROM reg_sources) as total_sources
      `);
    }

    // Latest run info
    let runInfo = null;
    if (effectiveRunId) {
      const runResult = await db.execute(sql`
        SELECT id, label, state, scope, status, started_at, completed_at
        FROM map_runs WHERE id = ${effectiveRunId}
      `);
      runInfo = (runResult.rows || runResult)?.[0] || null;
    }

    return Response.json({
      stats: stats.rows?.[0] || stats[0] || {},
      facilities: facilities.rows || facilities || [],
      sources: sources.rows || sources || [],
      run: runInfo,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
