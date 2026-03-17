import { getRemediationGroups } from '@/lib/remediation';

export const dynamic = 'force-dynamic';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;

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

function parsePositiveInt(value, fallback, cap = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return cap ? Math.min(parsed, cap) : parsed;
}

function parseSort(value) {
  return ['worst', 'policy_number', 'title'].includes(value) ? value : 'worst';
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
    const sort = parseSort(searchParams.get('sort'));
    const page = parsePositiveInt(searchParams.get('page'), DEFAULT_PAGE);
    const pageSize = parsePositiveInt(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const payload = await getRemediationGroups(
      runId,
      getFilters(searchParams),
      sort,
      page,
      pageSize,
    );

    return Response.json(payload);
  } catch (err) {
    console.error('Remediation groups error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
