import { db } from '@/lib/db';
import { coverageAssessments } from '@/lib/schema';
import { eq } from 'drizzle-orm';

export async function POST(req) {
  try {
    const body = await req.json();
    const { assessment_id, human_status, review_notes, reviewed_by } = body;

    if (!assessment_id || !human_status) {
      return Response.json({ error: 'Missing assessment_id or human_status' }, { status: 400 });
    }

    const validStatuses = ['COVERED', 'PARTIAL', 'GAP', 'NOT_APPLICABLE'];
    if (!validStatuses.includes(human_status)) {
      return Response.json({ error: `Invalid status: ${human_status}` }, { status: 400 });
    }

    await db.update(coverageAssessments)
      .set({
        human_status,
        review_notes: review_notes || null,
        reviewed_by: reviewed_by || 'clo',
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(coverageAssessments.id, assessment_id));

    return Response.json({ ok: true, assessment_id, human_status });
  } catch (err) {
    console.error('Review error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
