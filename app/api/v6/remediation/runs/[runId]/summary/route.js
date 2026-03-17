import { getRemediationSummary } from '@/lib/remediation';

export const dynamic = 'force-dynamic';

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function parseStatus(value) {
  return value === 'GAP' || value === 'PARTIAL' ? value : null;
}

function parseBoolean(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getFilters(searchParams) {
  return {
    status: parseStatus(searchParams.get('status')),
    source: normalizeString(searchParams.get('source')),
    domain: normalizeString(searchParams.get('domain')),
    riskTier: normalizeString(searchParams.get('riskTier')),
    confidenceMin: parseNumber(searchParams.get('confidenceMin')),
    confidenceMax: parseNumber(searchParams.get('confidenceMax')),
    q: normalizeString(searchParams.get('q')),
    includeDefects: parseBoolean(searchParams.get('includeDefects')),
  };
}

export async function GET(req, { params }) {
  try {
    const runId = normalizeString(params?.runId);
    if (!runId) {
      return Response.json({ error: 'Missing runId' }, { status: 400 });
    }

    const { searchParams } = new URL(req.url);
    const summary = await getRemediationSummary(runId, getFilters(searchParams));

    return Response.json(summary);
  } catch (err) {
    console.error('Remediation summary error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
