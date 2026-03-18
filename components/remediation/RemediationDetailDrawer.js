'use client';

import { useEffect, useState } from 'react';
import { Badge, EmptyState, Spinner } from '@/components/shared';

const OVERRIDE_STATUSES = [
  'COVERED',
  'PARTIAL',
  'GAP',
  'NOT_APPLICABLE',
  'CONFLICTING',
  'NEEDS_LEGAL_REVIEW',
  'REVIEW_NEEDED',
];

const DEFECT_CLASS_OPTIONS = [
  {
    value: 'packet',
    label: 'Evidence packet issue',
    help: 'The source packet or attachments were incomplete, wrong, or mismatched.',
  },
  {
    value: 'neighbor_drift',
    label: 'Wrong neighboring context',
    help: 'The engine pulled in nearby text that did not belong to the actual requirement.',
  },
  {
    value: 'applicability',
    label: 'Applicability logic issue',
    help: 'The engine got the applicability logic wrong for this obligation or facility.',
  },
  {
    value: 'retrieval',
    label: 'Retrieval issue',
    help: 'The engine did not retrieve the right evidence or missed relevant evidence.',
  },
  {
    value: 'citation_extraction',
    label: 'Citation extraction issue',
    help: 'The extracted citation or source reference is wrong or incomplete.',
  },
  {
    value: 'json_parse',
    label: 'LLM response format error',
    help: 'The model response format broke and caused a bad assessment record.',
  },
  {
    value: 'admin_boundary',
    label: 'Facility or boundary issue',
    help: 'The engine used the wrong facility, boundary, or administrative context.',
  },
  {
    value: 'other',
    label: 'Other engine issue',
    help: 'Use this when the problem is clearly engine-related but does not fit the other options.',
  },
];

function formatLabel(value) {
  if (!value) return null;
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

function InfoRow({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-stone-400">{label}</p>
      <p className="mt-1 text-sm text-stone-700">{value}</p>
    </div>
  );
}

function MetaPill({ label, tone = 'stone' }) {
  const tones = {
    stone: 'bg-stone-100 text-stone-700 ring-stone-200',
    indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    red: 'bg-red-50 text-red-700 ring-red-200',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200',
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${tones[tone] || tones.stone}`}>
      {label}
    </span>
  );
}

function normalizeDraftValue(value) {
  return typeof value === 'string' ? value : '';
}

function toOptionalString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export default function RemediationDetailDrawer({
  open,
  assessmentId,
  loading,
  error,
  detail,
  onClose,
  onReviewSaved,
}) {
  const [overrideStatus, setOverrideStatus] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [defectClass, setDefectClass] = useState('');
  const [defectNote, setDefectNote] = useState('');
  const [dismissReason, setDismissReason] = useState('');
  const [dismissNote, setDismissNote] = useState('');
  const [mutationState, setMutationState] = useState({ action: null, error: null });

  const assessment = detail?.assessment || null;
  const obligation = detail?.obligation || null;
  const policy = detail?.policy || null;
  const provisions = detail?.provisions || [];
  const review = detail?.review || null;
  const defect = detail?.defect || null;
  const isSubmitting = Boolean(mutationState.action);
  const actionsDisabled = isSubmitting || loading || Boolean(error) || !assessment;
  const selectedDefectClassOption = DEFECT_CLASS_OPTIONS.find((option) => option.value === defectClass);

  useEffect(() => {
    if (!open) return;

    setOverrideStatus(normalizeDraftValue(review?.override_status));
    setOverrideNote(normalizeDraftValue(review?.note));
    setDefectClass(normalizeDraftValue(defect?.defect_class));
    setDefectNote(normalizeDraftValue(
      review?.disposition === 'flagged_engine_defect' ? review?.note : defect?.note,
    ));
    setDismissReason(normalizeDraftValue(review?.dismiss_reason));
    setDismissNote(normalizeDraftValue(review?.disposition === 'dismissed' ? review?.note : ''));
    setMutationState({ action: null, error: null });
  }, [
    assessmentId,
    defect?.defect_class,
    defect?.note,
    open,
    review?.disposition,
    review?.dismiss_reason,
    review?.note,
    review?.override_status,
  ]);

  if (!open) return null;

  async function submitReview(payload, action) {
    if (!assessmentId) return;

    setMutationState({ action, error: null });

    try {
      const response = await fetch(`/api/v6/remediation/assessments/${encodeURIComponent(assessmentId)}/review`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok) {
        throw new Error(result?.error || `Review update failed (${response.status})`);
      }

      setMutationState({ action: null, error: null });
      onReviewSaved?.(result);
    } catch (err) {
      setMutationState({ action: null, error: err.message });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close detail drawer"
        className="absolute inset-0 bg-stone-900/20"
        onClick={onClose}
      />
      <aside className="relative z-10 flex h-full w-full max-w-2xl flex-col border-l border-stone-200 bg-white shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-stone-200 bg-white/95 px-5 py-4 backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-stone-400">Assessment Detail</p>
              <h2 className="mt-1 text-lg font-semibold text-stone-900">
                {obligation?.citation || assessmentId || 'Assessment'}
              </h2>
              {assessmentId ? (
                <p className="mt-1 font-mono text-[11px] text-stone-400">{assessmentId}</p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-500 hover:bg-stone-50 hover:text-stone-900"
            >
              Close
            </button>
          </div>
        </div>

        <div className="border-b border-stone-200 bg-stone-50/80 px-5 py-4">
          <section className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-stone-900">Review Actions</h3>
                <p className="text-xs text-stone-500">
                  Use these controls to record your reviewer decision. They do not edit the source assessment record itself.
                </p>
              </div>
              {isSubmitting ? <p className="text-xs text-stone-400">Saving...</p> : null}
            </div>

            {mutationState.error ? (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {mutationState.error}
              </div>
            ) : null}

            {!assessment && !loading && !error ? (
              <div className="rounded border border-stone-200 bg-white px-3 py-2 text-sm text-stone-500">
                Load a remediation item to use the reviewer actions.
              </div>
            ) : null}

            <div className="max-h-[40vh] overflow-y-auto pr-1">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded border border-stone-200 bg-white p-3">
                  <div className="space-y-2">
                    <div>
                      <p className="text-sm font-medium text-stone-900">Confirm result</p>
                      <p className="text-xs leading-5 text-stone-500">
                        Use when the current engine result looks right and you want to mark it reviewed.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={actionsDisabled}
                      onClick={() => submitReview({
                        disposition: 'confirmed',
                        note: review?.note ?? null,
                      }, 'confirmed')}
                      className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {mutationState.action === 'confirmed' ? 'Confirming...' : 'Confirm Result'}
                    </button>
                  </div>
                </div>

                <form
                  className="rounded border border-stone-200 bg-white p-3 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!overrideStatus) return;

                    submitReview({
                      disposition: 'overridden',
                      overrideStatus,
                      note: toOptionalString(overrideNote),
                    }, 'overridden');
                  }}
                >
                  <div>
                    <p className="text-sm font-medium text-stone-900">Reviewer-corrected status</p>
                    <p className="text-xs leading-5 text-stone-500">
                      Use this when the engine status is wrong and you want to record the reviewer-corrected result.
                    </p>
                  </div>

                  <label className="space-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Corrected Status</span>
                    <select
                      value={overrideStatus}
                      onChange={(event) => setOverrideStatus(event.target.value)}
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                      disabled={actionsDisabled}
                    >
                      <option value="">Select corrected status</option>
                      {OVERRIDE_STATUSES.map((status) => (
                        <option key={status} value={status}>{status}</option>
                      ))}
                    </select>
                  </label>

                  <label className="space-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Reviewer Note</span>
                    <textarea
                      value={overrideNote}
                      onChange={(event) => setOverrideNote(event.target.value)}
                      rows={3}
                      disabled={actionsDisabled}
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                      placeholder="Optional note about why the status is being corrected"
                    />
                  </label>

                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-stone-400">
                      {!overrideStatus ? 'Choose the corrected status first.' : 'This records the reviewer-corrected outcome.'}
                    </p>
                    <button
                      type="submit"
                      disabled={actionsDisabled || !overrideStatus}
                      className="rounded bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {mutationState.action === 'overridden' ? 'Saving...' : 'Save Corrected Status'}
                    </button>
                  </div>
                </form>

                <form
                  className="rounded border border-stone-200 bg-white p-3 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();

                    submitReview({
                      disposition: 'flagged_engine_defect',
                      defectClass: toOptionalString(defectClass),
                      note: toOptionalString(defectNote),
                    }, 'flagged_engine_defect');
                  }}
                >
                  <div>
                    <p className="text-sm font-medium text-stone-900">Flag as engine issue</p>
                    <p className="text-xs leading-5 text-stone-500">
                      Use this when the problem looks like an engine mistake, not a real remediation gap to work.
                    </p>
                  </div>

                  <label className="space-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Issue Type</span>
                    <select
                      value={defectClass}
                      onChange={(event) => setDefectClass(event.target.value)}
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                      disabled={actionsDisabled}
                    >
                      <option value="">Use default issue type (Other engine issue)</option>
                      {DEFECT_CLASS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>

                  <p className="text-[11px] leading-5 text-stone-500">
                    {selectedDefectClassOption?.help || 'Pick the closest explanation for how the engine got off track.'}
                  </p>

                  <label className="space-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Reviewer Note</span>
                    <textarea
                      value={defectNote}
                      onChange={(event) => setDefectNote(event.target.value)}
                      rows={3}
                      disabled={actionsDisabled}
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                      placeholder="Optional note about what looks wrong in the engine behavior"
                    />
                  </label>

                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-stone-400">By default, flagged rows drop out of the main remediation list.</p>
                    <button
                      type="submit"
                      disabled={actionsDisabled}
                      className="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {mutationState.action === 'flagged_engine_defect' ? 'Saving...' : 'Mark Engine Issue'}
                    </button>
                  </div>
                </form>

                <form
                  className="rounded border border-stone-200 bg-white p-3 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();

                    submitReview({
                      disposition: 'dismissed',
                      dismissReason: toOptionalString(dismissReason),
                      note: toOptionalString(dismissNote),
                    }, 'dismissed');
                  }}
                >
                  <div>
                    <p className="text-sm font-medium text-stone-900">Dismiss from review queue</p>
                    <p className="text-xs leading-5 text-stone-500">
                      Use when this item does not need reviewer follow-up right now, even though you want to keep a record of the decision.
                    </p>
                  </div>

                  <label className="space-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Reason</span>
                    <input
                      value={dismissReason}
                      onChange={(event) => setDismissReason(event.target.value)}
                      disabled={actionsDisabled}
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                      placeholder="Optional reason for dismissing"
                    />
                  </label>

                  <label className="space-y-1">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-stone-500">Reviewer Note</span>
                    <textarea
                      value={dismissNote}
                      onChange={(event) => setDismissNote(event.target.value)}
                      rows={3}
                      disabled={actionsDisabled}
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                      placeholder="Optional note explaining why review is being dismissed"
                    />
                  </label>

                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-stone-400">Dismissed items stay visible unless other filters remove them.</p>
                    <button
                      type="submit"
                      disabled={actionsDisabled}
                      className="rounded bg-stone-700 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {mutationState.action === 'dismissed' ? 'Saving...' : 'Dismiss Item'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </section>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="space-y-5 p-5">
          {loading ? <Spinner /> : null}

          {!loading && error ? (
            <div className="card p-4">
              <p className="text-sm font-medium text-red-700">Failed to load assessment detail</p>
              <p className="mt-1 text-xs text-stone-500">{error}</p>
            </div>
          ) : null}

          {!loading && !error && !assessment ? (
            <EmptyState message="No detail available for this assessment" />
          ) : null}

          {!loading && !error && assessment ? (
            <>
              <section className="card space-y-3 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge status={assessment.status} />
                  {assessment.confidence ? <MetaPill label={`Confidence: ${assessment.confidence}`} /> : null}
                  {assessment.mapRunId ? <MetaPill label={`Run: ${assessment.mapRunId}`} /> : null}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoRow label="Citation" value={obligation?.citation} />
                  <InfoRow label="Risk Tier" value={obligation?.riskTier} />
                </div>

                <div>
                  <p className="text-[11px] uppercase tracking-wide text-stone-400">Requirement</p>
                  <p className="mt-1 text-sm leading-6 text-stone-800">{obligation?.requirement || 'No requirement text'}</p>
                </div>

                {assessment.gapDetail ? (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-stone-400">Gap Detail</p>
                    <p className="mt-1 rounded border border-red-100 bg-red-50 px-3 py-2 text-sm leading-6 text-red-900">
                      {assessment.gapDetail}
                    </p>
                  </div>
                ) : null}

                {assessment.reasoning ? (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-stone-400">Reasoning</p>
                    <p className="mt-1 text-sm leading-6 text-stone-700">{assessment.reasoning}</p>
                  </div>
                ) : null}
              </section>

              <section className="card space-y-3 p-4">
                <div>
                  <h3 className="text-sm font-semibold text-stone-900">Matched Policy</h3>
                  <p className="text-xs text-stone-500">Policy metadata and indexed provisions</p>
                </div>

                {policy ? (
                  <>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <InfoRow label="Policy Number" value={policy.policyNumber} />
                      <InfoRow label="Domain" value={policy.domain} />
                      <InfoRow label="Title" value={policy.title} />
                      <InfoRow label="Sub-domain" value={policy.subDomain} />
                    </div>

                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-stone-400">Provisions</p>
                      {provisions.length > 0 ? (
                        <div className="mt-2 space-y-2">
                          {provisions.map((provision) => (
                            <div key={provision.id} className="rounded border border-stone-200 bg-stone-50 px-3 py-2">
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
                                {provision.section ? <span className="font-mono">{provision.section}</span> : null}
                                {provision.sourceCitation ? <span>{provision.sourceCitation}</span> : null}
                              </div>
                              <p className="mt-1 text-sm leading-6 text-stone-700">{provision.text}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-stone-500">No provisions were returned for the matched policy.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-stone-500">
                    No matched policy is associated with this assessment. This is expected for true GAP or Unassigned rows.
                  </p>
                )}
              </section>

              <section className="grid gap-5 lg:grid-cols-2">
                <div className="card space-y-3 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-stone-900">Review State</h3>
                    <p className="text-xs text-stone-500">Current remediation review record</p>
                  </div>

                  {review ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <MetaPill label={formatLabel(review.disposition)} tone="indigo" />
                        {review.override_status ? <MetaPill label={`Override: ${review.override_status}`} tone="amber" /> : null}
                      </div>
                      <InfoRow label="Reviewed At" value={formatDate(review.reviewed_at)} />
                      <InfoRow label="Reviewed By" value={review.reviewed_by} />
                      <InfoRow label="Note" value={review.note} />
                      <InfoRow label="Dismiss Reason" value={review.dismiss_reason} />
                    </>
                  ) : (
                    <p className="text-sm text-stone-500">No review has been recorded yet.</p>
                  )}
                </div>

                <div className="card space-y-3 p-4">
                  <div>
                    <h3 className="text-sm font-semibold text-stone-900">Defect State</h3>
                    <p className="text-xs text-stone-500">Existing engine-defect record, if any</p>
                  </div>

                  {defect ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <MetaPill label={formatLabel(defect.defect_class)} tone="red" />
                        <MetaPill label={formatLabel(defect.status)} />
                      </div>
                      <InfoRow label="Severity" value={defect.severity} />
                      <InfoRow label="Owner" value={defect.owner} />
                      <InfoRow label="Seeded From" value={defect.seeded_from} />
                      <InfoRow label="Updated At" value={formatDate(defect.updated_at)} />
                      <InfoRow label="Note" value={defect.note} />
                    </>
                  ) : (
                    <p className="text-sm text-stone-500">No system defect is attached to this assessment.</p>
                  )}
                </div>
              </section>
            </>
          ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
