import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const domain = searchParams.get('domain');
    const search = searchParams.get('search');

    const results = await db.execute(sql`
      SELECT 
        p.id,
        p.policy_number,
        p.title,
        p.domain,
        p.facility_name,
        p.effective_date,
        p.summary,
        p.status,
        p.indexed_at,
        (SELECT count(*) FROM provisions pv WHERE pv.policy_id = p.id) as provision_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id) as assessment_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id AND ca.status = 'COVERED') as covered_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id AND ca.status = 'PARTIAL') as partial_count
      FROM policies p
      WHERE p.indexed_at IS NOT NULL
      ORDER BY p.policy_number
    `);

    let rows = results.rows || results || [];

    if (domain && domain !== 'all') {
      rows = rows.filter(r => r.domain === domain);
    }
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        (r.policy_number || '').toLowerCase().includes(q) ||
        (r.title || '').toLowerCase().includes(q)
      );
    }

    const domains = [...new Set(rows.map(r => r.domain).filter(Boolean))].sort();

    return Response.json({
      policies: rows,
      total: rows.length,
      domains,
    });
  } catch (err) {
    console.error('Policies error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
