import Link from 'next/link';
import DefectQueueTable from '@/components/remediation/DefectQueueTable';

export default function RemediationDefectsPage({ params }) {
  return (
    <main className="min-h-screen bg-stone-50 text-stone-900">
      <div className="mx-auto max-w-[1480px] px-6 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-xs font-medium text-stone-500 hover:text-stone-900"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-stone-900 text-white text-[11px] font-semibold">
              PG
            </span>
            Back to PolicyGuard
          </Link>

          <nav className="flex items-center gap-2">
            <Link
              href={`/remediation/${params.runId}`}
              className="rounded-full border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-white hover:text-stone-900"
            >
              Remediation
            </Link>
            <Link
              href={`/remediation/${params.runId}/defects`}
              className="rounded-full bg-stone-900 px-3 py-1.5 text-xs font-medium text-white"
            >
              Defect Queue
            </Link>
          </nav>
        </div>

        <DefectQueueTable runId={params.runId} />
      </div>
    </main>
  );
}
