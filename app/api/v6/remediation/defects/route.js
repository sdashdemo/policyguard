import { getDefectQueue } from '@/lib/remediation';

export const dynamic = 'force-dynamic';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function parsePositiveInt(value, fallback, cap = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return cap ? Math.min(parsed, cap) : parsed;
}

function getFilters(searchParams) {
  return {
    status: normalizeString(searchParams.get('status')),
    severity: normalizeString(searchParams.get('severity')),
    owner: normalizeString(searchParams.get('owner')),
    source: normalizeString(searchParams.get('source')),
    policyNumber: normalizeString(searchParams.get('policyNumber')),
    q: normalizeString(searchParams.get('q')),
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const runId = normalizeString(searchParams.get('runId'));
    if (!runId) {
      return Response.json({ error: 'Missing runId' }, { status: 400 });
    }

    const page = parsePositiveInt(searchParams.get('page'), DEFAULT_PAGE);
    const pageSize = parsePositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const payload = await getDefectQueue(runId, getFilters(searchParams), page, pageSize);
    return Response.json(payload);
  } catch (err) {
    console.error('Remediation defects error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
