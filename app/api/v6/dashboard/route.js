import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const facilities = await db.execute(sql`
      SELECT * FROM v_facility_coverage ORDER BY state, name
    `);
    const sources = await db.execute(sql`
      SELECT * FROM v_source_coverage ORDER BY state NULLS LAST, name
    `);
    const stats = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM obligations) as total_obligations,
        (SELECT count(*) FROM coverage_assessments) as total_assessed,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'COVERED') as covered,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'PARTIAL') as partial,
        (SELECT count(*) FROM coverage_assessments WHERE status = 'GAP') as gaps,
        (SELECT count(*) FROM coverage_assessments WHERE human_status IS NOT NULL) as human_reviewed,
        (SELECT count(*) FROM policies) as total_policies,
        (SELECT count(*) FROM provisions) as total_provisions,
        (SELECT count(*) FROM reg_sources) as total_sources
    `);
    return Response.json({
      stats: stats.rows?.[0] || stats[0] || {},
      facilities: facilities.rows || facilities || [],
      sources: sources.rows || sources || [],
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
