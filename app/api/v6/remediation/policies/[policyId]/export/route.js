import {
  normalizeString,
  XLSX_MIME,
} from '../../../../../../../lib/remediation-export.js';
import {
  buildPerPolicyExportArtifact,
} from '../../../../../../../lib/remediation-policy-export.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req, { params }) {
  try {
    const policyId = normalizeString(params?.policyId);
    if (!policyId) {
      return Response.json({ error: 'Missing policyId' }, { status: 400 });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const runId = normalizeString(body?.runId);
    if (!runId) {
      return Response.json({ error: 'Missing runId' }, { status: 400 });
    }

    const { workbookBuffer, filename } = await buildPerPolicyExportArtifact({
      runId,
      policyId,
      filters: body?.filters,
    });

    return new Response(workbookBuffer, {
      status: 200,
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Per-policy export error:', err);
    return Response.json({ error: err.message }, { status: err.status || 500 });
  }
}
