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
        SELECT id FROM map_runs ORDER BY (status = 'completed') DESC, created_at DESC LIMIT 1
      `);
      effectiveRunId = (latest.rows || latest)?.[0]?.id || null;
    }

    // Facilities (from view — not run-scoped yet, but still useful for the picker)
    const facilities = await db.execute(sql`
      SELECT * FROM v_facility_coverage ORDER BY state, name
    `);

    // Sources (from view)
    const sources = await db.execute(sql`
      SELECT * FROM v_source_coverage ORDER BY state NULLS LAST, name
    `);

    // Run-scoped stats using effective_status
    const runFilter = effectiveRunId
      ? sql`WHERE ca.map_run_id = ${effectiveRunId}`
      : sql``;

    const stats = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM obligations) as total_obligations,
        (SELECT count(DISTINCT ca.obligation_id) FROM coverage_assessments ca ${runFilter}) as total_assessed,
        (SELECT count(*) FROM coverage_assessments ca ${runFilter} WHERE COALESCE(ca.human_status, ca.status) = 'COVERED') as covered,
        (SELECT count(*) FROM coverage_assessments ca ${runFilter} WHERE COALESCE(ca.human_status, ca.status) = 'PARTIAL') as partial,
        (SELECT count(*) FROM coverage_assessments ca ${runFilter} WHERE COALESCE(ca.human_status, ca.status) = 'GAP') as gaps,
        (SELECT count(*) FROM coverage_assessments ca ${runFilter} WHERE ca.human_status IS NOT NULL) as human_reviewed,
        (SELECT count(*) FROM policies) as total_policies,
        (SELECT count(*) FROM provisions) as total_provisions,
        (SELECT count(*) FROM reg_sources) as total_sources
    `);

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
