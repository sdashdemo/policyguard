import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getAssessmentPolicyLink } from '@/lib/remediation';
import {
  assessmentPolicyLinks,
  coverageAssessments,
  policies,
} from '@/lib/schema';

export const dynamic = 'force-dynamic';

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized || null;
}

function validatePutBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request body' };
  }

  const policyId = normalizeString(body.policyId);
  if (!policyId) {
    return { error: 'policyId is required' };
  }

  const linkedByInput = normalizeString(body.linkedBy);
  if (linkedByInput === false) {
    return { error: 'Invalid linkedBy' };
  }

  const note = normalizeString(body.note);
  if (note === false) {
    return { error: 'Invalid note' };
  }

  return {
    policyId,
    linkedBy: linkedByInput || 'clo',
    note,
  };
}

async function loadPayloadOrNotFound(assessmentId) {
  const payload = await getAssessmentPolicyLink(assessmentId);
  return payload.assessment ? payload : null;
}

export async function GET(req, { params }) {
  try {
    const assessmentId = normalizeString(params?.assessmentId);
    if (!assessmentId) {
      return Response.json({ error: 'Missing assessmentId' }, { status: 400 });
    }

    const payload = await loadPayloadOrNotFound(assessmentId);
    if (!payload) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return Response.json(payload);
  } catch (err) {
    console.error('Remediation policy-link read error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
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

    const parsed = validatePutBody(body);
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

      const [policy] = await tx
        .select({
          id: policies.id,
          policy_number: policies.policy_number,
          indexed_at: policies.indexed_at,
        })
        .from(policies)
        .where(eq(policies.id, parsed.policyId))
        .limit(1);

      if (!policy) {
        return { policyNotFound: true };
      }

      if (!policy.indexed_at || !normalizeString(policy.policy_number)) {
        return { invalidPolicy: true };
      }

      const [link] = await tx
        .insert(assessmentPolicyLinks)
        .values({
          assessment_id: assessmentId,
          policy_id: parsed.policyId,
          link_basis: 'reviewer_selected',
          linked_by: parsed.linkedBy,
          note: parsed.note,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: assessmentPolicyLinks.assessment_id,
          set: {
            policy_id: parsed.policyId,
            link_basis: 'reviewer_selected',
            linked_by: parsed.linkedBy,
            note: parsed.note,
            updated_at: now,
          },
        })
        .returning();

      return { link };
    });

    if (result.notFound) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    if (result.policyNotFound) {
      return Response.json({ error: 'Selected policy was not found' }, { status: 404 });
    }

    if (result.invalidPolicy) {
      return Response.json({
        error: 'Selected policy must be indexed and have a policy number before it can be linked here',
      }, { status: 400 });
    }

    const payload = await loadPayloadOrNotFound(assessmentId);
    return Response.json({
      ok: true,
      link: result.link,
      ...payload,
    });
  } catch (err) {
    console.error('Remediation policy-link save error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const assessmentId = normalizeString(params?.assessmentId);
    if (!assessmentId) {
      return Response.json({ error: 'Missing assessmentId' }, { status: 400 });
    }

    const result = await db.transaction(async (tx) => {
      const [assessment] = await tx
        .select({ id: coverageAssessments.id })
        .from(coverageAssessments)
        .where(eq(coverageAssessments.id, assessmentId))
        .limit(1);

      if (!assessment) {
        return { notFound: true };
      }

      const [deletedLink] = await tx
        .delete(assessmentPolicyLinks)
        .where(eq(assessmentPolicyLinks.assessment_id, assessmentId))
        .returning();

      return { deletedLink: deletedLink || null };
    });

    if (result.notFound) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const payload = await loadPayloadOrNotFound(assessmentId);
    return Response.json({
      ok: true,
      cleared: Boolean(result.deletedLink),
      ...payload,
    });
  } catch (err) {
    console.error('Remediation policy-link clear error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
