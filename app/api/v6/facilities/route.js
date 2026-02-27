import { db } from '@/lib/db';
import { facilityProfiles } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (id) {
      const facility = await db.select().from(facilityProfiles).where(eq(facilityProfiles.id, id));
      if (!facility.length) return Response.json({ error: 'Not found' }, { status: 404 });

      const state = facility[0].state;
      const oblResults = await db.execute(sql`
        SELECT 
          o.id, o.citation, o.requirement, o.source_type, o.topics, 
          o.levels_of_care, o.responsible_party, o.timeframe,
          rs.name as source_name, rs.state as source_state, rs.source_type as reg_source_type,
          ca.id as assessment_id, ca.status, ca.confidence, ca.gap_detail,
          ca.recommended_policy, ca.policy_id, ca.human_status, ca.reviewed_at,
          ca.review_notes,
          p.policy_number, p.title as policy_title
        FROM obligations o
        JOIN reg_sources rs ON o.reg_source_id = rs.id
        LEFT JOIN coverage_assessments ca ON ca.obligation_id = o.id
        LEFT JOIN policies p ON ca.policy_id = p.id
        WHERE rs.state = ${state} OR rs.state IS NULL OR rs.state = 'ALL'
        ORDER BY rs.name, o.citation
      `);

      return Response.json({
        facility: facility[0],
        obligations: oblResults.rows || oblResults || [],
      });
    }

    const results = await db.execute(sql`SELECT * FROM v_facility_coverage ORDER BY state, name`);
    return Response.json({ facilities: results.rows || results || [] });

  } catch (err) {
    console.error('Facilities error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req) {
  try {
    const body = await req.json();
    const { id, levels_of_care, license_types, services_offered, services_excluded, prohibits_restraint, bed_count } = body;

    if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });

    await db.update(facilityProfiles)
      .set({
        levels_of_care: levels_of_care || [],
        license_types: license_types || [],
        services_offered: services_offered || [],
        services_excluded: services_excluded || [],
        prohibits_restraint: prohibits_restraint ?? true,
        bed_count: bed_count || null,
        updated_at: new Date(),
      })
      .where(eq(facilityProfiles.id, id));

    return Response.json({ ok: true });
  } catch (err) {
    console.error('Facility update error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
