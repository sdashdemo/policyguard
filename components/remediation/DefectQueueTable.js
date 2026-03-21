'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge, EmptyState, Spinner, StatCard } from '@/components/shared';
import RemediationDetailDrawer from '@/components/remediation/RemediationDetailDrawer';

const FILTER_KEYS = ['status', 'severity', 'owner', 'source', 'policyNumber', 'q', 'page', 'pageSize'];
const DEFAULT_PAGE_SIZE = '25';

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function buildQueryString(searchParams, keys) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = searchParams.get(key);
    if (value !== null && value !== '') params.set(key, value);
  }
  return params.toString();
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status})`);
  }
  return payload;
}

function formatLabel(value) {
  if (!value) return null;
  return String(value).replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function truncateText(value, maxLength = 140) {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function getDefectTone(status) {
  switch (status) {
    case 'open':
      return 'bg-red-50 text-red-700 ring-red-200';
    case 'acknowledged':
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    case 'fixed':
      return 'bg-indigo-50 text-indigo-700 ring-indigo-200';
    case 'wont_fix':
    default:
      return 'bg-stone-100 text-stone-700 ring-stone-200';
  }
}

function getSeverityTone(severity) {
  switch (severity) {
    case 'high':
      return 'bg-red-50 text-red-700 ring-red-200';
    case 'medium':
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    case 'low':
    default:
      return 'bg-stone-100 text-stone-700 ring-stone-200';
  }
}

function ReviewPill({ disposition }) {
  const effectiveDisposition = disposition || 'unreviewed';
  const tone = effectiveDisposition === 'flagged_engine_defect'
    ? 'bg-red-50 text-red-700 ring-red-200'
    : 'bg-stone-100 text-stone-700 ring-stone-200';

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${tone}`}>
      {formatLabel(effectiveDisposition)}
    </span>
  );
}

function QueueStatusPill({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${getDefectTone(status)}`}>
      {formatLabel(status)}
    </span>
  );
}

function SeverityPill({ severity }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${getSeverityTone(severity)}`}>
      {formatLabel(severity)}
    </span>
  );
}

function QueueSummary({ runId, state, refreshing, onRefresh }) {
  if (state.loading) return <Spinner />;
  if (state.error) {
    return (
      <div className="card p-4">
        <p className="text-sm font-medium text-red-700">Failed to load defect queue</p>
        <p className="mt-1 text-xs text-stone-500">{state.error}</p>
      </div>
    );
  }

  const data = state.data;
  if (!data) return null;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-stone-400">Remediation</p>
          <h1 className="mt-1 text-2xl font-semibold">Defect Queue</h1>
          <p className="mt-1 text-sm text-stone-500">
            Run <span className="font-mono text-stone-700">{runId}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="max-w-md text-right text-xs text-stone-500">
            The <span className="font-mono text-stone-700">flagged_engine_defect</span> review disposition explains why an assessment left normal remediation. Queue lifecycle below tracks separate triage and resolution on the system defect record.
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-stone-50 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Defects" value={data.totalDefects || 0} color="text-red-700" />
        <StatCard label="Open" value={data.counts?.open || 0} color="text-red-700" />
        <StatCard label="Acknowledged" value={data.counts?.acknowledged || 0} color="text-amber-700" />
        <StatCard label="Fixed" value={data.counts?.fixed || 0} color="text-indigo-700" />
        <StatCard label="Won't Fix" value={data.counts?.wont_fix || 0} />
      </div>
    </section>
  );
}

function QueueFilters({ values, onChange, onReset, pending }) {
  return (
    <section className="card space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Filters</h2>
          <p className="text-xs text-stone-500">Run-scoped lifecycle filters for existing defect rows.</p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-stone-50 hover:text-stone-900"
        >
          Reset
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Queue Status</span>
          <select
            value={values.status}
            onChange={(event) => onChange({ status: event.target.value || null })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="fixed">Fixed</option>
            <option value="wont_fix">Won't fix</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Severity</span>
          <select
            value={values.severity}
            onChange={(event) => onChange({ severity: event.target.value || null })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All severities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Owner</span>
          <input
            value={values.owner}
            onChange={(event) => onChange({ owner: event.target.value || null })}
            placeholder="Reviewer or queue owner"
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Source</span>
          <input
            value={values.source}
            onChange={(event) => onChange({ source: event.target.value || null })}
            placeholder="e.g. TJC"
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Policy Group</span>
          <input
            value={values.policyNumber}
            onChange={(event) => onChange({ policyNumber: event.target.value || null })}
            placeholder="Policy # or Unassigned"
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Search</span>
          <input
            value={values.q}
            onChange={(event) => onChange({ q: event.target.value || null })}
            placeholder="Citation, policy, note, owner"
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Page Size</span>
          <select
            value={values.pageSize}
            onChange={(event) => onChange({ pageSize: event.target.value || DEFAULT_PAGE_SIZE })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
      </div>

      {pending ? <p className="text-xs text-stone-400">Updating filters...</p> : null}
    </section>
  );
}

function QueueTable({ state, selectedAssessmentId, page, onOpenAssessment, onPageChange }) {
  return (
    <section className="card flex min-h-0 flex-col overflow-hidden">
      <div className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Queue Items</h2>
            <p className="text-xs text-stone-500">Rows are keyed to existing defect records and stay tied to assessment detail.</p>
          </div>
          {state.data ? (
            <div className="text-right text-[11px] text-stone-500">
              <p>{state.data.totalDefects || 0} defects</p>
              <p>Page {state.data.page || 1} of {state.data.totalPages || 0}</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.loading ? <Spinner /> : null}

        {!state.loading && state.error ? (
          <div className="p-4">
            <p className="text-sm font-medium text-red-700">Failed to load defect queue</p>
            <p className="mt-1 text-xs text-stone-500">{state.error}</p>
          </div>
        ) : null}

        {!state.loading && !state.error && !state.data?.defects?.length ? (
          <EmptyState message="No defect rows match the current filters" />
        ) : null}

        {!state.loading && !state.error && state.data?.defects?.length ? (
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white text-left text-[11px] uppercase tracking-wide text-stone-500">
              <tr className="border-b border-stone-200">
                <th className="px-4 py-3">Assessment</th>
                <th className="px-4 py-3">Policy</th>
                <th className="px-4 py-3">Queue</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Review</th>
                <th className="px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {state.data.defects.map((item) => {
                const isSelected = selectedAssessmentId === item.assessmentId;
                return (
                  <tr
                    key={item.defectId}
                    onClick={() => onOpenAssessment(item.assessmentId)}
                    className={`cursor-pointer transition-colors ${isSelected ? 'bg-stone-100' : 'hover:bg-stone-50'}`}
                  >
                    <td className="px-4 py-3 align-top">
                      <div className="font-mono text-xs text-stone-700">{item.citation}</div>
                      <p className="mt-1 max-w-lg leading-6 text-stone-800">{truncateText(item.requirement)}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge status={item.assessmentStatus} />
                        {item.confidence ? (
                          <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-700 ring-1 ring-stone-200">
                            Confidence: {item.confidence}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="text-sm font-medium text-stone-900">{item.policyNumber || 'Unassigned'}</p>
                      <p className="mt-1 text-[11px] text-stone-500">{item.policyTitle || 'No matched policy title'}</p>
                      {item.sourceName ? <p className="mt-2 text-[11px] text-stone-500">{item.sourceName}</p> : null}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-wrap gap-2">
                        <QueueStatusPill status={item.status} />
                        <SeverityPill severity={item.severity} />
                      </div>
                      <p className="mt-2 text-[11px] text-stone-500">{formatLabel(item.defectClass)}</p>
                      {item.resolvedAt ? (
                        <p className="mt-1 text-[11px] text-stone-500">Resolved {formatDate(item.resolvedAt)}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="text-sm text-stone-700">{item.owner || '-'}</p>
                      {item.note ? (
                        <p className="mt-2 max-w-[16rem] text-[11px] leading-5 text-stone-500">
                          {truncateText(item.note, 100)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <ReviewPill disposition={item.reviewDisposition} />
                      {item.overrideStatus ? (
                        <p className="mt-1 text-[11px] text-stone-500">Override: {formatLabel(item.overrideStatus)}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top text-[11px] text-stone-500">
                      {formatDate(item.updatedAt) || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>

      {state.data?.totalPages > 1 ? (
        <div className="flex items-center justify-between border-t border-stone-200 bg-stone-50 px-4 py-3 text-xs">
          <button
            type="button"
            onClick={() => onPageChange(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="rounded border border-stone-200 px-3 py-1.5 text-stone-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-stone-500">Page {state.data.page} of {state.data.totalPages}</span>
          <button
            type="button"
            onClick={() => onPageChange(Math.min(state.data.totalPages, page + 1))}
            disabled={page >= state.data.totalPages}
            className="rounded border border-stone-200 px-3 py-1.5 text-stone-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}

export default function DefectQueueTable({ runId }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [queueState, setQueueState] = useState({ loading: true, data: null, error: null });
  const [detailState, setDetailState] = useState({ loading: false, data: null, error: null });

  const queueQuery = buildQueryString(searchParams, FILTER_KEYS);
  const status = searchParams.get('status') || '';
  const severity = searchParams.get('severity') || '';
  const owner = searchParams.get('owner') || '';
  const source = searchParams.get('source') || '';
  const policyNumber = searchParams.get('policyNumber') || '';
  const q = searchParams.get('q') || '';
  const page = Number.parseInt(searchParams.get('page') || '1', 10) || 1;
  const pageSize = searchParams.get('pageSize') || DEFAULT_PAGE_SIZE;
  const selectedAssessmentId = normalizeString(searchParams.get('assessmentId'));

  const refreshData = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  const replaceParams = useCallback((updates, options = {}) => {
    const next = new URLSearchParams(searchParams.toString());
    if (options.resetPage !== false) next.delete('page');

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }

    const nextQuery = next.toString();
    startTransition(() => {
      router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
    });
  }, [pathname, router, searchParams, startTransition]);

  useEffect(() => {
    const controller = new AbortController();
    setQueueState((current) => ({ ...current, loading: true, error: null }));

    const query = queueQuery ? `${queueQuery}&runId=${encodeURIComponent(runId)}` : `runId=${encodeURIComponent(runId)}`;
    fetchJson(`/api/v6/remediation/defects?${query}`, controller.signal)
      .then((data) => setQueueState({ loading: false, data, error: null }))
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setQueueState({ loading: false, data: null, error: error.message });
      });

    return () => controller.abort();
  }, [queueQuery, refreshVersion, runId]);

  useEffect(() => {
    if (!selectedAssessmentId) {
      setDetailState({ loading: false, data: null, error: null });
      return undefined;
    }

    const controller = new AbortController();
    setDetailState((current) => ({ ...current, loading: true, error: null }));

    fetchJson(`/api/v6/remediation/assessments/${encodeURIComponent(selectedAssessmentId)}`, controller.signal)
      .then((data) => setDetailState({ loading: false, data, error: null }))
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setDetailState({ loading: false, data: null, error: error.message });
      });

    return () => controller.abort();
  }, [selectedAssessmentId, refreshVersion]);

  useEffect(() => {
    if (!selectedAssessmentId || queueState.loading || queueState.error) return;

    const stillVisible = (queueState.data?.defects || []).some(
      (item) => item.assessmentId === selectedAssessmentId,
    );

    if (!stillVisible) {
      replaceParams({ assessmentId: null }, { resetPage: false });
    }
  }, [queueState.data, queueState.error, queueState.loading, replaceParams, selectedAssessmentId]);

  return (
    <div className="page-enter space-y-5">
      <QueueSummary
        runId={runId}
        state={queueState}
        refreshing={queueState.loading || detailState.loading}
        onRefresh={refreshData}
      />

      <QueueFilters
        values={{ status, severity, owner, source, policyNumber, q, pageSize }}
        pending={isPending}
        onChange={(updates, options = {}) => replaceParams(updates, options)}
        onReset={() => replaceParams({
          status: null,
          severity: null,
          owner: null,
          source: null,
          policyNumber: null,
          q: null,
          page: null,
          pageSize: null,
          assessmentId: null,
        }, { resetPage: false })}
      />

      <div className="lg:h-[70vh]">
        <QueueTable
          state={queueState}
          selectedAssessmentId={selectedAssessmentId}
          page={page}
          onOpenAssessment={(assessmentId) => replaceParams({ assessmentId }, { resetPage: false })}
          onPageChange={(nextPage) => replaceParams({ page: nextPage }, { resetPage: false })}
        />
      </div>

      <RemediationDetailDrawer
        open={Boolean(selectedAssessmentId)}
        assessmentId={selectedAssessmentId}
        loading={detailState.loading}
        error={detailState.error}
        detail={detailState.data}
        onClose={() => replaceParams({ assessmentId: null }, { resetPage: false })}
        onReviewSaved={refreshData}
        onPolicyLinkSaved={refreshData}
        onDefectSaved={refreshData}
      />
    </div>
  );
}
