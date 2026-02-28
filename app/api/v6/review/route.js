import { db } from '@/lib/db';
import { coverageAssessments } from '@/lib/schema';
import { eq, inArray } from 'drizzle-orm';

export async function POST(req) {
  try {
    const body = await req.json();
    const { assessment_id, assessment_ids, human_status, review_notes, reviewed_by } = body;

    if (!human_status) {
      return Response.json({ error: 'Missing human_status' }, { status: 400 });
    }

    const validStatuses = ['COVERED', 'PARTIAL', 'GAP', 'NOT_APPLICABLE', 'CONFLICTING'];
    if (!validStatuses.includes(human_status)) {
      return Response.json({ error: `Invalid status: ${human_status}` }, { status: 400 });
    }

    const ids = assessment_ids || (assessment_id ? [assessment_id] : []);
    if (ids.length === 0) {
      return Response.json({ error: 'Missing assessment_id or assessment_ids' }, { status: 400 });
    }

    // Bulk mode
    if (ids.length > 1) {
      await db.update(coverageAssessments)
        .set({
          human_status,
          review_notes: review_notes || null,
          reviewed_by: reviewed_by || 'clo',
          reviewed_at: new Date(),
          updated_at: new Date(),
        })
        .where(inArray(coverageAssessments.id, ids));
      return Response.json({ ok: true, updated: ids.length, human_status });
    }

    // Single mode
    await db.update(coverageAssessments)
      .set({
        human_status,
        review_notes: review_notes || null,
        reviewed_by: reviewed_by || 'clo',
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(coverageAssessments.id, ids[0]));

    return Response.json({ ok: true, assessment_id: ids[0], human_status });
  } catch (err) {
    console.error('Review error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
