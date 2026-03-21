import { searchRemediationPolicies } from '@/lib/remediation';

export const dynamic = 'force-dynamic';

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

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const q = normalizeString(searchParams.get('q') || searchParams.get('search'));
    const limit = parsePositiveInt(searchParams.get('limit'), 10, 50);

    const policies = await searchRemediationPolicies(q, limit);

    return Response.json({
      q,
      total: policies.length,
      policies,
    });
  } catch (err) {
    console.error('Remediation policy search error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
