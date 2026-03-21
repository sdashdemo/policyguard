'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge, EmptyState, Spinner, StatCard } from '@/components/shared';
import RemediationDetailDrawer from '@/components/remediation/RemediationDetailDrawer';

const FILTER_KEYS = ['status', 'source', 'domain', 'riskTier', 'confidenceMin', 'confidenceMax', 'q', 'includeDefects'];
const GROUP_QUERY_KEYS = [...FILTER_KEYS, 'sort', 'page', 'pageSize'];
const ITEMS_QUERY_KEYS = [...FILTER_KEYS, 'policyNumber'];
const UNASSIGNED_BUCKET = 'Unassigned';

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

function parseFilenameFromDisposition(disposition) {
  if (!disposition) return null;
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]);
  const filenameMatch = disposition.match(/filename="?([^"]+)"?/i);
  return filenameMatch?.[1] || null;
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

function truncateText(value, maxLength = 160) {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function getPolicyExportState(selectedPolicyNumber, selectedGroup, groupsLoading) {
  if (groupsLoading) {
    return {
      disabled: true,
      helperText: 'Policy export will be available after the selected group metadata loads.',
    };
  }

  if (!selectedPolicyNumber) {
    return {
      disabled: true,
      helperText: 'Select a policy group to export a standalone policy workbook.',
    };
  }

  if (!selectedGroup) {
    return {
      disabled: true,
      helperText: 'The selected policy group is not available on the current page yet.',
    };
  }

  if (selectedPolicyNumber === UNASSIGNED_BUCKET) {
    return {
      disabled: true,
      helperText: 'Unassigned rows do not resolve to a standalone policy export.',
    };
  }

  if ((selectedGroup.distinctPolicyIds || 0) > 1) {
    return {
      disabled: true,
      helperText: 'This policy-number group spans multiple canonical policy records, so standalone export stays disabled for now.',
    };
  }

  if (!selectedGroup.canonicalPolicyId) {
    return {
      disabled: true,
      helperText: 'This group does not have a canonical policy record yet.',
    };
  }

  return {
    disabled: false,
    helperText: 'Export uses the canonical linked policy plus the current remediation filters.',
  };
}

function getReviewTone(disposition) {
  switch (disposition) {
    case 'confirmed': return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    case 'overridden': return 'bg-amber-50 text-amber-700 ring-amber-200';
    case 'flagged_engine_defect': return 'bg-red-50 text-red-700 ring-red-200';
    case 'dismissed': return 'bg-stone-200 text-stone-700 ring-stone-300';
    default: return 'bg-stone-100 text-stone-500 ring-stone-200';
  }
}

function ReviewPill({ disposition }) {
  const effectiveDisposition = disposition || 'unreviewed';
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${getReviewTone(effectiveDisposition)}`}>
      {formatLabel(effectiveDisposition)}
    </span>
  );
}

function SummarySection({
  runId,
  state,
  refreshing,
  exporting,
  exportError,
  onRefresh,
  onExport,
  onSelectPolicy,
}) {
  if (state.loading) return <Spinner />;
  if (state.error) {
    return (
      <div className="card p-4">
        <p className="text-sm font-medium text-red-700">Failed to load summary</p>
        <p className="mt-1 text-xs text-stone-500">{state.error}</p>
      </div>
    );
  }

  const summary = state.data;
  if (!summary) return null;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-stone-400">Remediation</p>
          <h1 className="mt-1 text-2xl font-semibold">Remediation</h1>
          <p className="mt-1 text-sm text-stone-500">
            Run <span className="font-mono text-stone-700">{runId}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-xs text-stone-500">Review progress follows persisted remediation dispositions only.</div>
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            className="rounded border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-stone-50 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? 'Exporting...' : 'Export XLSX'}
          </button>
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

      {exportError ? (
        <p className="text-sm text-red-700">{exportError}</p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Gaps" value={summary.gapCount || 0} color="text-red-700" />
        <StatCard label="Partial" value={summary.partialCount || 0} color="text-amber-700" />
        <StatCard label="Policies" value={summary.totalPoliciesNeedingWork || 0} />
        <StatCard label="Reviewed" value={summary.reviewedCount || 0} color="text-indigo-700" />
        <StatCard label="Dismissed" value={summary.dismissedCount || 0} />
        <StatCard label="Defects" value={summary.defectCount || 0} color="text-red-700" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),380px]">
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-stone-900">Progress</h2>
          <p className="text-xs text-stone-500">Current review disposition totals</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ReviewPill disposition="unreviewed" />
            <span className="text-sm font-semibold text-stone-700">{summary.progress?.unreviewed || 0}</span>
            <ReviewPill disposition="confirmed" />
            <span className="text-sm font-semibold text-stone-700">{summary.progress?.confirmed || 0}</span>
            <ReviewPill disposition="overridden" />
            <span className="text-sm font-semibold text-stone-700">{summary.progress?.overridden || 0}</span>
            <ReviewPill disposition="flagged_engine_defect" />
            <span className="text-sm font-semibold text-stone-700">{summary.progress?.flagged_engine_defect || 0}</span>
            <ReviewPill disposition="dismissed" />
            <span className="text-sm font-semibold text-stone-700">{summary.progress?.dismissed || 0}</span>
          </div>
        </div>

        <div className="card p-4">
          <h2 className="text-sm font-semibold text-stone-900">Top Severity Groups</h2>
          <p className="text-xs text-stone-500">Top 10 by weighted score</p>
          {summary.topPolicies?.length ? (
            <div className="mt-3 space-y-2">
              {summary.topPolicies.slice(0, 5).map((group) => (
                <button
                  key={group.policyNumber}
                  type="button"
                  onClick={() => onSelectPolicy(group.policyNumber)}
                  className="flex w-full items-center justify-between rounded border border-stone-200 px-3 py-2 text-left hover:bg-stone-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-900">{group.policyNumber}</p>
                    <p className="truncate text-xs text-stone-500">{group.policyTitle || 'No matched policy title'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-stone-900">{group.score}</p>
                    <p className="text-[11px] text-stone-500">{group.totalCount} items</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm text-stone-500">No severity groups are available for the current filters.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function FiltersBar({ values, onChange, onReset, pending }) {
  return (
    <section className="card p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-900">Filters</h2>
          <p className="text-xs text-stone-500">All filters are URL-backed and drive server-side queries.</p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="rounded border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-stone-50 hover:text-stone-900"
        >
          Reset
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Status</span>
          <select
            value={values.status}
            onChange={(event) => onChange({ status: event.target.value || null })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All remediation</option>
            <option value="GAP">GAP</option>
            <option value="PARTIAL">PARTIAL</option>
          </select>
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
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Domain</span>
          <input
            value={values.domain}
            onChange={(event) => onChange({ domain: event.target.value || null })}
            placeholder="e.g. medications"
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Risk Tier</span>
          <input
            value={values.riskTier}
            onChange={(event) => onChange({ riskTier: event.target.value || null })}
            placeholder="e.g. critical"
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          />
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Search</span>
          <input
            value={values.q}
            onChange={(event) => onChange({ q: event.target.value || null })}
            placeholder="Citation, requirement, policy #"
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Confidence Min</span>
          <select
            value={values.confidenceMin}
            onChange={(event) => onChange({ confidenceMin: event.target.value || null })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">Any</option>
            <option value="1">Low+</option>
            <option value="2">Medium+</option>
            <option value="3">High only</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Confidence Max</span>
          <select
            value={values.confidenceMax}
            onChange={(event) => onChange({ confidenceMax: event.target.value || null })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">Any</option>
            <option value="1">Low only</option>
            <option value="2">Low / Medium</option>
            <option value="3">High</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Sort</span>
          <select
            value={values.sort}
            onChange={(event) => onChange({ sort: event.target.value || 'worst' }, { resetPage: false })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="worst">Worst first</option>
            <option value="policy_number">Policy number</option>
            <option value="title">Title</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Page Size</span>
          <select
            value={values.pageSize}
            onChange={(event) => onChange({ pageSize: event.target.value || '25' })}
            className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>

        <label className="flex items-center gap-3 rounded border border-stone-200 bg-stone-50 px-3 py-2">
          <input
            type="checkbox"
            checked={values.includeDefects}
            onChange={(event) => onChange({ includeDefects: event.target.checked ? 'true' : 'false' })}
          />
          <span className="text-sm text-stone-700">Include defect-linked rows</span>
        </label>
      </div>

      {pending ? <p className="text-xs text-stone-400">Updating filters...</p> : null}
    </section>
  );
}

function GroupsPane({ state, selectedPolicyNumber, page, onPageChange, onSelectPolicy }) {
  return (
    <section className="card flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Policy Groups</h2>
            <p className="text-xs text-stone-500">Grouped by canonical policy link, with an Unassigned bucket.</p>
          </div>
          {state.data ? (
            <div className="text-right text-[11px] text-stone-500">
              <p>{state.data.totalGroups || 0} groups</p>
              <p>Page {state.data.page || 1} of {state.data.totalPages || 0}</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.loading ? <Spinner /> : null}

        {!state.loading && state.error ? (
          <div className="p-4">
            <p className="text-sm font-medium text-red-700">Failed to load remediation groups</p>
            <p className="mt-1 text-xs text-stone-500">{state.error}</p>
          </div>
        ) : null}

        {!state.loading && !state.error && !state.data?.groups?.length ? (
          <EmptyState message="No remediation groups match the current filters" />
        ) : null}

        {!state.loading && !state.error && state.data?.groups?.length ? (
          <div className="divide-y divide-stone-100">
            {state.data.groups.map((group) => {
              const isSelected = selectedPolicyNumber === group.policyNumber;
              return (
                <button
                  key={group.policyNumber}
                  type="button"
                  onClick={() => onSelectPolicy(group.policyNumber)}
                  className={`block w-full px-4 py-3 text-left transition-colors ${isSelected ? 'bg-stone-900 text-white' : 'hover:bg-stone-50'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`truncate text-sm font-semibold ${isSelected ? 'text-white' : 'text-stone-900'}`}>
                        {group.policyNumber}
                      </p>
                      <p className={`mt-1 truncate text-xs ${isSelected ? 'text-stone-300' : 'text-stone-500'}`}>
                        {group.policyTitle || 'No matched policy title'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-lg font-semibold tabular-nums ${isSelected ? 'text-white' : 'text-stone-900'}`}>
                        {group.score}
                      </p>
                      <p className={`text-[11px] ${isSelected ? 'text-stone-300' : 'text-stone-500'}`}>score</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                    <span className={`rounded-full px-2 py-0.5 ring-1 ${isSelected ? 'bg-red-500/15 text-red-100 ring-red-400/40' : 'bg-red-50 text-red-700 ring-red-200'}`}>
                      GAP {group.gapCount}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 ring-1 ${isSelected ? 'bg-amber-500/15 text-amber-100 ring-amber-400/40' : 'bg-amber-50 text-amber-700 ring-amber-200'}`}>
                      PARTIAL {group.partialCount}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 ring-1 ${isSelected ? 'bg-stone-500/20 text-stone-100 ring-stone-400/40' : 'bg-stone-100 text-stone-700 ring-stone-200'}`}>
                      TOTAL {group.totalCount}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
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

function ItemsPane({
  state,
  selectedPolicyNumber,
  selectedAssessmentId,
  policyExporting,
  policyExportError,
  policyExportDisabled,
  policyExportHelperText,
  onExportPolicy,
  onOpenAssessment,
}) {
  return (
    <section className="card flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-stone-900">Remediation Items</h2>
            <p className="text-xs text-stone-500">
              {selectedPolicyNumber ? (
                <>Selected group: <span className="font-medium text-stone-700">{selectedPolicyNumber}</span></>
              ) : (
                'Select a policy group to review individual assessments.'
              )}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {state.items?.length ? <p className="text-[11px] text-stone-500">{state.items.length} items</p> : null}
            <button
              type="button"
              onClick={onExportPolicy}
              disabled={policyExporting || policyExportDisabled}
              title={policyExportDisabled ? policyExportHelperText : 'Export standalone policy workbook'}
              className="rounded border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-white hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {policyExporting ? 'Exporting...' : 'Export Policy XLSX'}
            </button>
          </div>
        </div>
        {policyExportHelperText ? (
          <p className="mt-2 text-[11px] text-stone-500">{policyExportHelperText}</p>
        ) : null}
        {policyExportError ? (
          <p className="mt-2 text-xs text-red-700">{policyExportError}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.loading ? <Spinner /> : null}

        {!state.loading && state.error ? (
          <div className="p-4">
            <p className="text-sm font-medium text-red-700">Failed to load remediation items</p>
            <p className="mt-1 text-xs text-stone-500">{state.error}</p>
          </div>
        ) : null}

        {!state.loading && !state.error && !selectedPolicyNumber ? (
          <EmptyState message="Select a policy group to load remediation items" />
        ) : null}

        {!state.loading && !state.error && selectedPolicyNumber && !state.items?.length ? (
          <EmptyState message="No remediation items were returned for the selected policy group" />
        ) : null}

        {!state.loading && !state.error && state.items?.length ? (
          <table className="min-w-full text-sm">
            <thead className="sticky top-0 z-10 bg-white text-left text-[11px] uppercase tracking-wide text-stone-500">
              <tr className="border-b border-stone-200">
                <th className="px-4 py-3">Citation</th>
                <th className="px-4 py-3">Requirement</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Confidence</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Risk</th>
                <th className="px-4 py-3">Review</th>
                <th className="px-4 py-3">Defect</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {state.items.map((item) => {
                const isSelected = selectedAssessmentId === item.assessmentId;
                return (
                  <tr
                    key={item.assessmentId}
                    onClick={() => onOpenAssessment(item.assessmentId)}
                    className={`cursor-pointer transition-colors ${isSelected ? 'bg-stone-100' : 'hover:bg-stone-50'}`}
                  >
                    <td className="px-4 py-3 align-top">
                      <div className="font-mono text-xs text-stone-700">{item.citation}</div>
                      {item.coveringPolicyNumber ? (
                        <div className="mt-1 text-[11px] text-stone-500">{item.coveringPolicyNumber}</div>
                      ) : (
                        <div className="mt-1 text-[11px] text-stone-400">Unassigned</div>
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <p className="max-w-xl leading-6 text-stone-800">{truncateText(item.requirement)}</p>
                      {item.policyTitle ? <p className="mt-1 text-[11px] text-stone-500">{item.policyTitle}</p> : null}
                    </td>
                    <td className="px-4 py-3 align-top"><Badge status={item.status} /></td>
                    <td className="px-4 py-3 align-top text-stone-600">{item.confidence || '-'}</td>
                    <td className="px-4 py-3 align-top text-stone-600">{item.sourceName || '-'}</td>
                    <td className="px-4 py-3 align-top text-stone-600">{item.riskTier || '-'}</td>
                    <td className="px-4 py-3 align-top">
                      <ReviewPill disposition={item.reviewDisposition} />
                      {item.overrideStatus ? (
                        <p className="mt-1 text-[11px] text-stone-500">
                          Override: {formatLabel(item.overrideStatus)}
                        </p>
                      ) : null}
                      {item.reviewNote ? (
                        <p className="mt-1 max-w-[16rem] text-[11px] leading-5 text-stone-500">
                          {truncateText(item.reviewNote, 88)}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {item.hasDefect ? (
                        <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-red-200">
                          Defect
                        </span>
                      ) : (
                        <span className="text-stone-300">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}

export default function RemediationWorkspace({ runId }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [exportState, setExportState] = useState({ loading: false, error: null });
  const [policyExportState, setPolicyExportState] = useState({ loading: false, error: null });
  const [summaryState, setSummaryState] = useState({ loading: true, data: null, error: null });
  const [groupsState, setGroupsState] = useState({ loading: true, data: null, error: null });
  const [itemsState, setItemsState] = useState({ loading: false, items: [], error: null, requestKey: null });
  const [detailState, setDetailState] = useState({ loading: false, data: null, error: null });

  const summaryQuery = buildQueryString(searchParams, FILTER_KEYS);
  const groupsQuery = buildQueryString(searchParams, GROUP_QUERY_KEYS);
  const itemsQuery = buildQueryString(searchParams, ITEMS_QUERY_KEYS);
  const status = searchParams.get('status') || '';
  const source = searchParams.get('source') || '';
  const domain = searchParams.get('domain') || '';
  const riskTier = searchParams.get('riskTier') || '';
  const confidenceMin = searchParams.get('confidenceMin') || '';
  const confidenceMax = searchParams.get('confidenceMax') || '';
  const q = searchParams.get('q') || '';
  const includeDefects = searchParams.get('includeDefects') === 'true';
  const sort = searchParams.get('sort') || 'worst';
  const page = Number.parseInt(searchParams.get('page') || '1', 10) || 1;
  const pageSize = searchParams.get('pageSize') || '25';
  const selectedPolicyNumber = normalizeString(searchParams.get('policyNumber'));
  const selectedAssessmentId = normalizeString(searchParams.get('assessmentId'));
  const currentItemsRequestKey = selectedPolicyNumber
    ? `${runId}:${itemsQuery}:${refreshVersion}`
    : null;
  const selectedGroup = groupsState.data?.groups?.find((group) => group.policyNumber === selectedPolicyNumber) || null;
  const policyExportAvailability = getPolicyExportState(
    selectedPolicyNumber,
    selectedGroup,
    groupsState.loading,
  );
  const isRefreshing = summaryState.loading || groupsState.loading || itemsState.loading || detailState.loading;
  const currentFilters = {
    status: status || null,
    source: source || null,
    domain: domain || null,
    riskTier: riskTier || null,
    confidenceMin: confidenceMin ? Number.parseInt(confidenceMin, 10) : null,
    confidenceMax: confidenceMax ? Number.parseInt(confidenceMax, 10) : null,
    q: q || null,
    includeDefects: includeDefects ? true : null,
  };

  // Step 7 review actions can call this after a successful PUT to refetch every
  // route-backed panel without disturbing the current URL-driven workspace state.
  const refreshRemediationData = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  const handleExportXlsx = useCallback(async () => {
    setExportState({ loading: true, error: null });

    try {
      const response = await fetch('/api/v6/remediation/export', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          filters: currentFilters,
          sort,
          pageSize: Number.parseInt(pageSize, 10) || null,
        }),
      });

      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        throw new Error(payload?.error || `Export failed (${response.status})`);
      }

      const blob = await response.blob();
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'))
        || `remediation_${runId}.xlsx`;
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
      setExportState({ loading: false, error: null });
    } catch (error) {
      setExportState({ loading: false, error: error.message });
    }
  }, [currentFilters, pageSize, runId, sort]);

  const handlePolicyExportXlsx = useCallback(async () => {
    if (!selectedGroup?.canonicalPolicyId) return;

    setPolicyExportState({ loading: true, error: null });

    try {
      const response = await fetch(`/api/v6/remediation/policies/${encodeURIComponent(selectedGroup.canonicalPolicyId)}/export`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          filters: currentFilters,
        }),
      });

      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        throw new Error(payload?.error || `Policy export failed (${response.status})`);
      }

      const blob = await response.blob();
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'))
        || `policy_${selectedGroup.policyNumber || 'export'}_${runId}.xlsx`;
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
      setPolicyExportState({ loading: false, error: null });
    } catch (error) {
      setPolicyExportState({ loading: false, error: error.message });
    }
  }, [currentFilters, runId, selectedGroup]);

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

  const handlePolicyLinkSaved = useCallback((payload) => {
    const nextPolicyNumber = normalizeString(payload?.policyLink?.effectivePolicyNumber) || UNASSIGNED_BUCKET;
    replaceParams({ policyNumber: nextPolicyNumber }, { resetPage: false });
    refreshRemediationData();
  }, [refreshRemediationData, replaceParams]);

  useEffect(() => {
    setPolicyExportState((current) => (current.loading ? current : { loading: false, error: null }));
  }, [selectedPolicyNumber, groupsQuery]);

  useEffect(() => {
    const controller = new AbortController();
    setSummaryState((current) => ({ ...current, loading: true, error: null }));

    const url = summaryQuery
      ? `/api/v6/remediation/runs/${encodeURIComponent(runId)}/summary?${summaryQuery}`
      : `/api/v6/remediation/runs/${encodeURIComponent(runId)}/summary`;

    fetchJson(url, controller.signal)
      .then((data) => setSummaryState({ loading: false, data, error: null }))
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setSummaryState({ loading: false, data: null, error: error.message });
      });

    return () => controller.abort();
  }, [runId, summaryQuery, refreshVersion]);

  useEffect(() => {
    const controller = new AbortController();
    setGroupsState((current) => ({ ...current, loading: true, error: null }));

    const url = groupsQuery
      ? `/api/v6/remediation/runs/${encodeURIComponent(runId)}/groups?${groupsQuery}`
      : `/api/v6/remediation/runs/${encodeURIComponent(runId)}/groups`;

    fetchJson(url, controller.signal)
      .then((data) => setGroupsState({ loading: false, data, error: null }))
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setGroupsState({ loading: false, data: null, error: error.message });
      });

    return () => controller.abort();
  }, [runId, groupsQuery, refreshVersion]);

  useEffect(() => {
    const groups = groupsState.data?.groups || [];
    if (groupsState.loading || groupsState.error) return;

    if (groups.length === 0) {
      if (selectedPolicyNumber || selectedAssessmentId) {
        replaceParams({ policyNumber: null, assessmentId: null }, { resetPage: false });
      }
      return;
    }

    const hasSelectedPolicy = selectedPolicyNumber
      ? groups.some((group) => group.policyNumber === selectedPolicyNumber)
      : false;

    if (!hasSelectedPolicy) {
      replaceParams({ policyNumber: groups[0].policyNumber, assessmentId: null }, { resetPage: false });
    }
  }, [groupsState.loading, groupsState.error, groupsState.data, selectedPolicyNumber, selectedAssessmentId, replaceParams]);

  useEffect(() => {
    if (!selectedPolicyNumber) {
      setItemsState({ loading: false, items: [], error: null, requestKey: null });
      return undefined;
    }

    const controller = new AbortController();
    setItemsState((current) => ({
      ...current,
      loading: true,
      error: null,
      requestKey: currentItemsRequestKey,
    }));

    const url = itemsQuery
      ? `/api/v6/remediation/runs/${encodeURIComponent(runId)}/items?${itemsQuery}`
      : `/api/v6/remediation/runs/${encodeURIComponent(runId)}/items`;

    fetchJson(url, controller.signal)
      .then((data) => setItemsState({
        loading: false,
        items: data.items || [],
        error: null,
        requestKey: currentItemsRequestKey,
      }))
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setItemsState({
          loading: false,
          items: [],
          error: error.message,
          requestKey: currentItemsRequestKey,
        });
      });

    return () => controller.abort();
  }, [runId, selectedPolicyNumber, itemsQuery, currentItemsRequestKey]);

  useEffect(() => {
    if (!selectedAssessmentId || !selectedPolicyNumber) return;
    if (itemsState.loading || itemsState.error) return;
    if (itemsState.requestKey !== currentItemsRequestKey) return;

    const selectedAssessmentStillVisible = itemsState.items.some(
      (item) => item.assessmentId === selectedAssessmentId,
    );

    if (!selectedAssessmentStillVisible) {
      replaceParams({ assessmentId: null }, { resetPage: false });
    }
  }, [
    currentItemsRequestKey,
    itemsState.error,
    itemsState.items,
    itemsState.loading,
    itemsState.requestKey,
    replaceParams,
    selectedAssessmentId,
    selectedPolicyNumber,
  ]);

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

  return (
    <div className="page-enter space-y-5">
      <SummarySection
        runId={runId}
        state={summaryState}
        refreshing={isRefreshing}
        exporting={exportState.loading}
        exportError={exportState.error}
        onRefresh={refreshRemediationData}
        onExport={handleExportXlsx}
        onSelectPolicy={(policyNumber) => replaceParams({ policyNumber, assessmentId: null }, { resetPage: false })}
      />

      <FiltersBar
        values={{ status, source, domain, riskTier, confidenceMin, confidenceMax, q, includeDefects, sort, pageSize }}
        pending={isPending}
        onChange={(updates, options = {}) => replaceParams(updates, options)}
        onReset={() => replaceParams({
          status: null,
          source: null,
          domain: null,
          riskTier: null,
          confidenceMin: null,
          confidenceMax: null,
          q: null,
          includeDefects: null,
          sort: null,
          page: null,
          pageSize: null,
          policyNumber: null,
          assessmentId: null,
        }, { resetPage: false })}
      />

      <div className="grid gap-5 lg:min-h-[34rem] lg:grid-cols-[22rem,minmax(0,1fr)] lg:h-[70vh]">
        <GroupsPane
          state={groupsState}
          selectedPolicyNumber={selectedPolicyNumber}
          page={page}
          onSelectPolicy={(policyNumber) => replaceParams({ policyNumber, assessmentId: null }, { resetPage: false })}
          onPageChange={(nextPage) => replaceParams({ page: nextPage }, { resetPage: false })}
        />

        <ItemsPane
          state={itemsState}
          selectedPolicyNumber={selectedPolicyNumber}
          selectedAssessmentId={selectedAssessmentId}
          policyExporting={policyExportState.loading}
          policyExportError={policyExportState.error}
          policyExportDisabled={policyExportAvailability.disabled}
          policyExportHelperText={policyExportAvailability.helperText}
          onExportPolicy={handlePolicyExportXlsx}
          onOpenAssessment={(assessmentId) => replaceParams({ assessmentId }, { resetPage: false })}
        />
      </div>

      <RemediationDetailDrawer
        open={Boolean(selectedAssessmentId)}
        assessmentId={selectedAssessmentId}
        loading={detailState.loading}
        error={detailState.error}
        detail={detailState.data}
        onClose={() => replaceParams({ assessmentId: null }, { resetPage: false })}
        onReviewSaved={refreshRemediationData}
        onPolicyLinkSaved={handlePolicyLinkSaved}
        onDefectSaved={refreshRemediationData}
      />
    </div>
  );
}
