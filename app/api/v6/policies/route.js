import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const domain = searchParams.get('domain');
    const search = searchParams.get('search');

    // ─── Single policy detail ───────────────────────
    if (id) {
      const policyResult = await db.execute(sql`
        SELECT
          p.id, p.policy_number, p.title, p.domain, p.sub_domain,
          p.facility_name, p.effective_date, p.revision_dates,
          p.purpose, p.summary, p.full_text, p.status, p.indexed_at,
          p.dcf_citations, p.tjc_citations, p.section_headings,
          p.topics_covered, p.source_file,
          (SELECT count(*) FROM provisions pv WHERE pv.policy_id = p.id) as provision_count,
          (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id) as assessment_count
        FROM policies p
        WHERE p.id = ${id}
      `);

      const policy = (policyResult.rows || policyResult)?.[0];
      if (!policy) return Response.json({ error: 'Not found' }, { status: 404 });

      // Get provisions
      const provsResult = await db.execute(sql`
        SELECT id, text, section, source_citation, keywords
        FROM provisions
        WHERE policy_id = ${id}
        ORDER BY section, id
      `);

      // Get linked obligations (via coverage_assessments)
      const oblsResult = await db.execute(sql`
        SELECT
          o.id as obligation_id, o.citation, o.requirement, o.risk_tier,
          rs.name as source_name, rs.state as source_state,
          ca.id as assessment_id, ca.status, ca.confidence, ca.gap_detail,
          ca.recommended_policy, ca.human_status, ca.review_notes, ca.reviewed_at,
          ca.match_score, ca.match_method, ca.reasoning,
          ca.obligation_span, ca.provision_span
        FROM coverage_assessments ca
        JOIN obligations o ON ca.obligation_id = o.id
        JOIN reg_sources rs ON o.reg_source_id = rs.id
        WHERE ca.policy_id = ${id}
        ORDER BY
          CASE ca.status
            WHEN 'GAP' THEN 1
            WHEN 'CONFLICTING' THEN 2
            WHEN 'PARTIAL' THEN 3
            WHEN 'COVERED' THEN 4
            ELSE 5
          END,
          o.citation
      `);

      return Response.json({
        policy,
        provisions: provsResult.rows || provsResult || [],
        obligations: oblsResult.rows || oblsResult || [],
      });
    }

    // ─── Policy list ────────────────────────────────
    const results = await db.execute(sql`
      SELECT
        p.id,
        p.policy_number,
        p.title,
        p.domain,
        p.facility_name,
        p.effective_date,
        p.summary,
        p.purpose,
        p.status,
        p.indexed_at,
        (SELECT count(*) FROM provisions pv WHERE pv.policy_id = p.id) as provision_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id) as assessment_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id AND ca.status = 'COVERED') as covered_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id AND ca.status = 'PARTIAL') as partial_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id AND ca.status = 'GAP') as gap_count,
        (SELECT count(*) FROM coverage_assessments ca WHERE ca.policy_id = p.id AND ca.status = 'CONFLICTING') as conflicting_count
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
        (r.title || '').toLowerCase().includes(q) ||
        (r.summary || '').toLowerCase().includes(q)
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
