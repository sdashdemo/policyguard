import { getAssessmentDetail } from '@/lib/remediation';

export const dynamic = 'force-dynamic';

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export async function GET(req, { params }) {
  try {
    const assessmentId = normalizeString(params?.assessmentId);
    if (!assessmentId) {
      return Response.json({ error: 'Missing assessmentId' }, { status: 400 });
    }

    const detail = await getAssessmentDetail(assessmentId);
    if (!detail.assessment) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    return Response.json(detail);
  } catch (err) {
    console.error('Remediation assessment detail error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
