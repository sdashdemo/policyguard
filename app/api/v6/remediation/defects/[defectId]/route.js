import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { getDefectQueueDetail } from '@/lib/remediation';
import { systemDefects } from '@/lib/schema';

export const dynamic = 'force-dynamic';

const VALID_DEFECT_STATUSES = ['open', 'acknowledged', 'fixed', 'wont_fix'];
const VALID_DEFECT_SEVERITIES = ['low', 'medium', 'high'];

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  return normalized || null;
}

function parsePatchString(body, key) {
  if (!Object.prototype.hasOwnProperty.call(body, key)) {
    return { provided: false, value: undefined };
  }

  const normalized = normalizeString(body[key]);
  if (normalized === false) {
    return { provided: true, error: `Invalid ${key}` };
  }

  return { provided: true, value: normalized };
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid request body' };
  }

  const statusPatch = parsePatchString(body, 'status');
  if (statusPatch.error) return { error: statusPatch.error };
  if (statusPatch.provided && statusPatch.value !== null && !VALID_DEFECT_STATUSES.includes(statusPatch.value)) {
    return { error: 'Invalid status' };
  }
  if (statusPatch.provided && statusPatch.value === null) {
    return { error: 'status cannot be empty' };
  }

  const severityPatch = parsePatchString(body, 'severity');
  if (severityPatch.error) return { error: severityPatch.error };
  if (severityPatch.provided && severityPatch.value !== null && !VALID_DEFECT_SEVERITIES.includes(severityPatch.value)) {
    return { error: 'Invalid severity' };
  }
  if (severityPatch.provided && severityPatch.value === null) {
    return { error: 'severity cannot be empty' };
  }

  const ownerPatch = parsePatchString(body, 'owner');
  if (ownerPatch.error) return { error: ownerPatch.error };

  const notePatch = parsePatchString(body, 'note');
  if (notePatch.error) return { error: notePatch.error };

  if (!statusPatch.provided && !severityPatch.provided && !ownerPatch.provided && !notePatch.provided) {
    return { error: 'At least one defect field is required' };
  }

  return {
    status: statusPatch.provided ? statusPatch.value : undefined,
    severity: severityPatch.provided ? severityPatch.value : undefined,
    owner: ownerPatch.provided ? ownerPatch.value : undefined,
    note: notePatch.provided ? notePatch.value : undefined,
  };
}

export async function GET(req, { params }) {
  try {
    const defectId = normalizeString(params?.defectId);
    if (!defectId) {
      return Response.json({ error: 'Missing defectId' }, { status: 400 });
    }

    const payload = await getDefectQueueDetail(defectId);
    if (!payload.detail?.assessment) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return Response.json(payload);
  } catch (err) {
    console.error('Remediation defect detail error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req, { params }) {
  try {
    const defectId = normalizeString(params?.defectId);
    if (!defectId) {
      return Response.json({ error: 'Missing defectId' }, { status: 400 });
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
      const [existing] = await tx
        .select()
        .from(systemDefects)
        .where(eq(systemDefects.id, defectId))
        .limit(1);

      if (!existing) {
        return { notFound: true };
      }

      const nextStatus = parsed.status ?? existing.status;
      let resolvedAt = existing.resolved_at ?? null;
      if (parsed.status !== undefined) {
        if (nextStatus === 'fixed' || nextStatus === 'wont_fix') {
          resolvedAt = resolvedAt || now;
        } else {
          resolvedAt = null;
        }
      }

      const updateSet = {
        updated_at: now,
      };

      if (parsed.status !== undefined) updateSet.status = nextStatus;
      if (parsed.severity !== undefined) updateSet.severity = parsed.severity;
      if (parsed.owner !== undefined) updateSet.owner = parsed.owner;
      if (parsed.note !== undefined) updateSet.note = parsed.note;
      if (parsed.status !== undefined) updateSet.resolved_at = resolvedAt;

      const [defect] = await tx
        .update(systemDefects)
        .set(updateSet)
        .where(eq(systemDefects.id, defectId))
        .returning();

      return { defect };
    });

    if (result.notFound) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return Response.json({
      ok: true,
      defect: result.defect,
    });
  } catch (err) {
    console.error('Remediation defect update error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
