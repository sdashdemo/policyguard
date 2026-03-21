import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  assessmentReviews,
  coverageAssessments,
  systemDefects,
} from '@/lib/schema';

export const dynamic = 'force-dynamic';

const VALID_DISPOSITIONS = [
  'confirmed',
  'overridden',
  'flagged_engine_defect',
  'dismissed',
];

const VALID_OVERRIDE_STATUSES = [
  'COVERED',
  'PARTIAL',
  'GAP',
  'NOT_APPLICABLE',
  'CONFLICTING',
  'NEEDS_LEGAL_REVIEW',
  'REVIEW_NEEDED',
];

const VALID_DEFECT_CLASSES = [
  'packet',
  'neighbor_drift',
  'applicability',
  'retrieval',
  'citation_extraction',
  'json_parse',
  'admin_boundary',
  'other',
];

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized || null;
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request body' };
  }

  if (!VALID_DISPOSITIONS.includes(body.disposition)) {
    return { error: 'Invalid disposition' };
  }

  const note = normalizeString(body.note);
  if (note === false) {
    return { error: 'Invalid note' };
  }

  const dismissReasonInput = normalizeString(body.dismissReason);
  if (dismissReasonInput === false) {
    return { error: 'Invalid dismissReason' };
  }

  let overrideStatus = null;
  if (body.disposition === 'overridden') {
    if (typeof body.overrideStatus !== 'string' || !VALID_OVERRIDE_STATUSES.includes(body.overrideStatus)) {
      return { error: 'overrideStatus is required for overridden reviews' };
    }
    overrideStatus = body.overrideStatus;
  }

  let defectClass = null;
  if (body.disposition === 'flagged_engine_defect') {
    const normalizedDefectClass = normalizeString(body.defectClass);
    if (normalizedDefectClass === false) {
      return { error: 'Invalid defectClass' };
    }
    defectClass = normalizedDefectClass || 'other';
    if (!VALID_DEFECT_CLASSES.includes(defectClass)) {
      return { error: 'Invalid defectClass' };
    }
  }

  return {
    disposition: body.disposition,
    overrideStatus,
    note,
    dismissReason: body.disposition === 'dismissed' ? dismissReasonInput : null,
    defectClass,
  };
}

export async function PUT(req, { params }) {
  try {
    const assessmentId = normalizeString(params?.assessmentId);
    if (!assessmentId) {
      return Response.json({ error: 'Missing assessmentId' }, { status: 400 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = validateBody(body);
    if (parsed.error) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const now = new Date();

    const result = await db.transaction(async (tx) => {
      const [assessment] = await tx
        .select({ id: coverageAssessments.id })
        .from(coverageAssessments)
        .where(eq(coverageAssessments.id, assessmentId))
        .limit(1);

      if (!assessment) {
        return { notFound: true };
      }

      const [review] = await tx
        .insert(assessmentReviews)
        .values({
          assessment_id: assessmentId,
          disposition: parsed.disposition,
          override_status: parsed.overrideStatus,
          note: parsed.note,
          dismiss_reason: parsed.dismissReason,
          reviewed_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: assessmentReviews.assessment_id,
          set: {
            disposition: parsed.disposition,
            override_status: parsed.overrideStatus,
            note: parsed.note,
            dismiss_reason: parsed.dismissReason,
            reviewed_at: now,
            updated_at: now,
          },
        })
        .returning();

      let defect = null;

      if (parsed.disposition === 'flagged_engine_defect') {
        const defectValues = {
          assessment_id: assessmentId,
          defect_class: parsed.defectClass,
          status: 'open',
          note: parsed.note,
          created_at: now,
          updated_at: now,
          resolved_at: null,
        };

        const defectUpdate = {
          defect_class: parsed.defectClass,
          status: 'open',
          updated_at: now,
          resolved_at: null,
        };

        if (parsed.note !== null) {
          defectUpdate.note = parsed.note;
        }

        [defect] = await tx
          .insert(systemDefects)
          .values(defectValues)
          .onConflictDoUpdate({
            target: systemDefects.assessment_id,
            set: defectUpdate,
          })
          .returning();
      } else {
        [defect] = await tx
          .select()
          .from(systemDefects)
          .where(eq(systemDefects.assessment_id, assessmentId))
          .limit(1);
      }

      return { review, defect: defect || null };
    });

    if (result.notFound) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return Response.json({
      ok: true,
      review: result.review,
      defect: result.defect,
    });
  } catch (err) {
    console.error('Remediation review error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
