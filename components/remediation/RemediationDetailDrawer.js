'use client';

import { useEffect, useRef, useState } from 'react';
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

const DEFECT_LIFECYCLE_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'wont_fix', label: "Won't fix" },
];

const DEFECT_SEVERITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
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

function getPolicyLinkStatus(source, hasEffectivePolicy) {
  switch (source) {
    case 'reviewer_selected':
      return {
        label: 'Reviewer selected',
        tone: 'indigo',
        helper: 'This assessment has an explicit reviewer-owned canonical policy link.',
      };
    case 'covering_policy_number_backfill':
      return {
        label: 'Backfill link',
        tone: 'amber',
        helper: 'This assessment has an explicit backfill-owned canonical policy link.',
      };
    case 'fallback_legacy_covering_policy_number':
      return {
        label: 'Legacy fallback',
        tone: 'stone',
        helper: hasEffectivePolicy
          ? 'No explicit canonical link has been saved yet. The current policy is still derived only from the legacy covering-policy number.'
          : 'No explicit canonical link has been saved yet. The drawer only has legacy coverage-based linkage and no resolved matched policy row.',
      };
    default:
      return {
        label: 'No effective link',
        tone: 'red',
        helper: 'No explicit canonical link or legacy coverage-based fallback is available for this assessment right now.',
      };
  }
}

function getDefectLifecycleTone(status) {
  switch (status) {
    case 'open':
      return 'red';
    case 'acknowledged':
      return 'amber';
    case 'fixed':
      return 'indigo';
    case 'wont_fix':
    default:
      return 'stone';
  }
}

function getSuggestFixStatus(metadata) {
  switch (metadata?.suggestionSource) {
    case 'persisted':
      return {
        label: 'Saved suggestion',
        tone: 'indigo',
        heading: 'Latest Saved Suggestion',
        helper: 'Showing the latest persisted Suggest Fix output for this assessment. Generate again any time to refresh it.',
      };
    case 'saved':
      return {
        label: 'Saved just now',
        tone: 'indigo',
        heading: 'Suggestion Saved',
        helper: 'Fresh suggestion output for this assessment. The latest result has been saved and policy health is reused from cache when the current matched-policy context still matches.',
      };
    default:
      return {
        label: 'Fresh suggestion',
        tone: 'amber',
        heading: 'Suggestion Ready',
        helper: 'Fresh suggestion output for this assessment. Policy health is reused from cache when the current matched-policy context still matches.',
      };
  }
}

function normalizeDisplayList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toOptionalString(item)).filter(Boolean);
  }

  const normalized = toOptionalString(value);
  if (!normalized) return [];

  if (!/\r?\n/.test(normalized)) {
    return [normalized];
  }

  return normalized
    .split(/\r?\n+/)
    .map((line) => toOptionalString(line.replace(/^[-*]\s*/, '')))
    .filter(Boolean);
}

function normalizeSuggestFixContent(value) {
  const structured = value?.suggestedFix && typeof value.suggestedFix === 'object' && !Array.isArray(value.suggestedFix)
    ? value.suggestedFix
    : null;
  const rawSuggestedFixText = structured ? null : toOptionalString(value?.suggestedFix);

  return {
    draftLanguage: toOptionalString(structured?.draftLanguage)
      || toOptionalString(value?.draftLanguage)
      || rawSuggestedFixText,
    implementationNotes: normalizeDisplayList(
      structured?.implementationNotes
      ?? value?.implementationNotes,
    ),
  };
}

function normalizePolicyHealthFindingsForDisplay(policyHealth) {
  const rawFindings = Array.isArray(policyHealth?.findings)
    ? policyHealth.findings
    : (Array.isArray(policyHealth?.issues) ? policyHealth.issues : []);

  return rawFindings
    .map((finding) => {
      if (typeof finding === 'string') {
        const issue = toOptionalString(finding);
        if (!issue) return null;
        return {
          severity: 'medium',
          type: 'general_gap',
          issue,
          suggestedInsertionPoint: null,
          staleCitation: false,
          abbreviationDiscipline: false,
          definedTermDiscipline: false,
        };
      }

      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        return null;
      }

      const issue = toOptionalString(finding.issue)
        || toOptionalString(finding.description)
        || toOptionalString(finding.summary);
      if (!issue) return null;

      return {
        severity: ['high', 'medium', 'low'].includes(String(finding.severity || '').toLowerCase())
          ? String(finding.severity).toLowerCase()
          : 'medium',
        type: toOptionalString(finding.type) || 'general_gap',
        issue,
        suggestedInsertionPoint: toOptionalString(finding.suggestedInsertionPoint)
          || toOptionalString(finding.insertionPoint)
          || toOptionalString(finding.location),
        staleCitation: finding.staleCitation === true,
        abbreviationDiscipline: finding.abbreviationDiscipline === true,
        definedTermDiscipline: finding.definedTermDiscipline === true,
      };
    })
    .filter(Boolean);
}

function formatFindingType(value) {
  if (!value) return 'General gap';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getFindingTone(severity) {
  switch (severity) {
    case 'high':
      return 'red';
    case 'medium':
      return 'amber';
    case 'low':
    default:
      return 'stone';
  }
}

function DisclosureSection({ title, helper, open, onToggle, children }) {
  return (
    <section className={`rounded border bg-white ${open ? 'border-stone-300 shadow-sm' : 'border-stone-200'}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left"
      >
        <div>
          <p className="text-sm font-medium text-stone-900">{title}</p>
          <p className="mt-0.5 text-xs leading-5 text-stone-500">{helper}</p>
        </div>
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${open ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600'}`}>
          {open ? 'Close' : 'Open'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-stone-100 px-3 py-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}

export default function RemediationDetailDrawer({
  open,
  assessmentId,
  loading,
  error,
  detail,
  onClose,
  onReviewSaved,
  onPolicyLinkSaved,
  onDefectSaved,
}) {
  const [overrideStatus, setOverrideStatus] = useState('');
  const [overrideNote, setOverrideNote] = useState('');
  const [defectClass, setDefectClass] = useState('');
  const [defectNote, setDefectNote] = useState('');
  const [dismissReason, setDismissReason] = useState('');
  const [dismissNote, setDismissNote] = useState('');
  const [policyLinkNote, setPolicyLinkNote] = useState('');
  const [policySearchTerm, setPolicySearchTerm] = useState('');
  const [selectedPolicyId, setSelectedPolicyId] = useState('');
  const [policySearchState, setPolicySearchState] = useState({
    loading: false,
    results: [],
    error: null,
    hasSearched: false,
  });
  const [policyLinkMutationState, setPolicyLinkMutationState] = useState({ action: null, error: null });
  const [mutationState, setMutationState] = useState({ action: null, error: null });
  const [defectLifecycleStatus, setDefectLifecycleStatus] = useState('open');
  const [defectSeverity, setDefectSeverity] = useState('medium');
  const [defectOwner, setDefectOwner] = useState('');
  const [defectLifecycleNote, setDefectLifecycleNote] = useState('');
  const [defectMutationState, setDefectMutationState] = useState({ action: null, error: null });
  const [suggestFixState, setSuggestFixState] = useState({
    loading: false,
    data: null,
    error: null,
  });
  const [activeActionPanel, setActiveActionPanel] = useState(null);
  const suggestFixResultRef = useRef(null);

  const assessment = detail?.assessment || null;
  const obligation = detail?.obligation || null;
  const policyLink = detail?.policyLink || null;
  const fixSuggestion = detail?.fixSuggestion || null;
  const policy = detail?.policy || null;
  const provisions = detail?.provisions || [];
  const review = detail?.review || null;
  const defect = detail?.defect || null;
  const isSubmitting = Boolean(mutationState.action);
  const policyLinkIsSubmitting = Boolean(policyLinkMutationState.action);
  const defectIsSubmitting = Boolean(defectMutationState.action);
  const actionsDisabled = isSubmitting || loading || Boolean(error) || !assessment;
  const policyLinkActionsDisabled = policyLinkIsSubmitting || loading || Boolean(error) || !assessment;
  const defectLifecycleDisabled = defectIsSubmitting || loading || Boolean(error) || !defect?.id;
  const selectedDefectClassOption = DEFECT_CLASS_OPTIONS.find((option) => option.value === defectClass);
  const policyLinkStatus = getPolicyLinkStatus(
    policyLink?.effectiveSource || null,
    Boolean(policyLink?.hasEffectivePolicy),
  );
  const suggestFixStatus = getSuggestFixStatus(suggestFixState.data?.metadata);
  const suggestFixContent = normalizeSuggestFixContent(suggestFixState.data);
  const policyHealthFindings = normalizePolicyHealthFindingsForDisplay(suggestFixState.data?.policyHealth);
  const selectedPolicyPreview = policySearchState.results.find((result) => result.id === selectedPolicyId)
    || (
      selectedPolicyId
        && policyLink?.hasExplicitLink
        && policy?.id === selectedPolicyId
        ? {
          id: policy.id,
          policyNumber: policy.policyNumber,
          title: policy.title,
          domain: policy.domain,
          subDomain: policy.subDomain,
        }
        : null
    );

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
    setPolicyLinkNote(normalizeDraftValue(policyLink?.note));
    setDefectLifecycleStatus(normalizeDraftValue(defect?.status || 'open'));
    setDefectSeverity(normalizeDraftValue(defect?.severity || 'medium'));
    setDefectOwner(normalizeDraftValue(defect?.owner));
    setDefectLifecycleNote(normalizeDraftValue(defect?.note));
    setPolicySearchTerm('');
    setSelectedPolicyId(policyLink?.hasExplicitLink ? normalizeDraftValue(policy?.id) : '');
    setPolicySearchState({
      loading: false,
      results: [],
      error: null,
      hasSearched: false,
    });
    setPolicyLinkMutationState({ action: null, error: null });
    setMutationState({ action: null, error: null });
    setDefectMutationState({ action: null, error: null });
    setSuggestFixState({ loading: false, data: fixSuggestion || null, error: null });
    setActiveActionPanel(null);
  }, [
    assessmentId,
    defect?.defect_class,
    defect?.note,
    defect?.owner,
    defect?.severity,
    defect?.status,
    fixSuggestion?.generatedAt,
    fixSuggestion?.id,
    fixSuggestion?.updatedAt,
    open,
    policy?.id,
    policyLink?.hasExplicitLink,
    policyLink?.note,
    review?.disposition,
    review?.dismiss_reason,
    review?.note,
    review?.override_status,
  ]);

  useEffect(() => {
    if (!suggestFixState.data || suggestFixState.loading) return;
    suggestFixResultRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, [suggestFixState.data, suggestFixState.loading]);

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

  async function searchPolicies() {
    const q = toOptionalString(policySearchTerm);
    if (!q) {
      setPolicySearchState({
        loading: false,
        results: [],
        error: 'Enter a policy number or title to search.',
        hasSearched: false,
      });
      return;
    }

    setPolicySearchState((current) => ({
      ...current,
      loading: true,
      error: null,
      hasSearched: true,
    }));

    try {
      const response = await fetch(`/api/v6/remediation/policies/search?q=${encodeURIComponent(q)}&limit=12`, {
        method: 'GET',
        cache: 'no-store',
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok) {
        throw new Error(result?.error || `Policy search failed (${response.status})`);
      }

      setPolicySearchState({
        loading: false,
        results: result?.policies || [],
        error: null,
        hasSearched: true,
      });
    } catch (err) {
      setPolicySearchState({
        loading: false,
        results: [],
        error: err.message,
        hasSearched: true,
      });
    }
  }

  async function savePolicyLink(event) {
    event.preventDefault();
    if (!assessmentId || !selectedPolicyId) return;

    setPolicyLinkMutationState({ action: 'save', error: null });

    try {
      const response = await fetch(`/api/v6/remediation/assessments/${encodeURIComponent(assessmentId)}/policy-link`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policyId: selectedPolicyId,
          linkedBy: 'clo',
          note: toOptionalString(policyLinkNote),
        }),
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok) {
        throw new Error(result?.error || `Policy link save failed (${response.status})`);
      }

      setPolicyLinkMutationState({ action: null, error: null });
      onPolicyLinkSaved?.(result);
    } catch (err) {
      setPolicyLinkMutationState({ action: null, error: err.message });
    }
  }

  async function clearPolicyLink() {
    if (!assessmentId) return;

    setPolicyLinkMutationState({ action: 'clear', error: null });

    try {
      const response = await fetch(`/api/v6/remediation/assessments/${encodeURIComponent(assessmentId)}/policy-link`, {
        method: 'DELETE',
        cache: 'no-store',
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok) {
        throw new Error(result?.error || `Policy link clear failed (${response.status})`);
      }

      setPolicyLinkMutationState({ action: null, error: null });
      onPolicyLinkSaved?.(result);
    } catch (err) {
      setPolicyLinkMutationState({ action: null, error: err.message });
    }
  }

  async function saveDefectLifecycle(event) {
    event.preventDefault();
    if (!defect?.id) return;

    setDefectMutationState({ action: 'save', error: null });

    try {
      const response = await fetch(`/api/v6/remediation/defects/${encodeURIComponent(defect.id)}`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: defectLifecycleStatus,
          severity: defectSeverity,
          owner: toOptionalString(defectOwner),
          note: toOptionalString(defectLifecycleNote),
        }),
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok) {
        throw new Error(result?.error || `Defect update failed (${response.status})`);
      }

      setDefectMutationState({ action: null, error: null });
      onDefectSaved?.(result);
    } catch (err) {
      setDefectMutationState({ action: null, error: err.message });
    }
  }

  async function requestSuggestFix() {
    if (!assessmentId) return;

    setSuggestFixState((current) => ({
      loading: true,
      data: current.data,
      error: null,
    }));

    try {
      const response = await fetch(`/api/v6/remediation/assessments/${encodeURIComponent(assessmentId)}/suggest-fix`, {
        method: 'POST',
        cache: 'no-store',
      });

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok) {
        throw new Error(result?.error || `Suggest Fix failed (${response.status})`);
      }

      setSuggestFixState({ loading: false, data: result, error: null });
    } catch (err) {
      setSuggestFixState((current) => ({
        loading: false,
        data: current.data,
        error: err.message,
      }));
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

            <div className="max-h-[48vh] overflow-y-auto pr-1">
              <div className="space-y-2 pb-2">
                <div className="rounded border border-stone-200 bg-white p-3">
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-sm font-medium text-stone-900">Suggest Fix</p>
                        <p className="text-xs leading-5 text-stone-500">
                          Generate or refresh the latest saved remediation language plus structured policy-health findings for this one item.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={actionsDisabled || suggestFixState.loading}
                        onClick={requestSuggestFix}
                        className="inline-flex w-full items-center justify-center rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      >
                        {suggestFixState.loading ? 'Generating Suggestion...' : (suggestFixState.data ? 'Regenerate Suggestion' : 'Suggest Fix')}
                      </button>
                    </div>

                    {suggestFixState.loading ? (
                      <div className="flex items-center gap-2 rounded border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600">
                        <Spinner />
                        <span>Generating and saving a fresh suggestion for this assessment...</span>
                      </div>
                    ) : null}

                    {suggestFixState.error ? (
                      <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                        {suggestFixState.error}
                      </p>
                    ) : null}

                    {suggestFixState.data ? (
                      <div
                        ref={suggestFixResultRef}
                        className="space-y-3 rounded border border-emerald-200 bg-emerald-50/60 px-3 py-3"
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div>
                            <p className="text-sm font-semibold text-stone-900">{suggestFixStatus.heading}</p>
                            <p className="text-xs leading-5 text-stone-500">
                              {suggestFixStatus.helper}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <MetaPill label={suggestFixStatus.label} tone={suggestFixStatus.tone} />
                            {suggestFixState.data.metadata?.hasMatchedPolicy ? (
                              <MetaPill label={`Matched Policy: ${suggestFixState.data.metadata.policyNumber || 'Unknown'}`} />
                            ) : (
                              <MetaPill label="No Matched Policy" tone="amber" />
                            )}
                            {suggestFixState.data.metadata?.policyHealthSource === 'cache_hit' ? (
                              <MetaPill label="Policy Health Cached" />
                            ) : null}
                            {suggestFixState.data.metadata?.policyHealthSource === 'generated' ? (
                              <MetaPill label="Policy Health Refreshed" tone="amber" />
                            ) : null}
                          </div>
                        </div>

                        {suggestFixState.data.metadata?.suggestionGeneratedAt ? (
                          <p className="text-[11px] text-stone-500">
                            {suggestFixState.data.metadata?.suggestionSource === 'persisted' || suggestFixState.data.metadata?.suggestionSource === 'saved'
                              ? 'Saved at'
                              : 'Generated at'} {formatDate(suggestFixState.data.metadata.suggestionGeneratedAt) || suggestFixState.data.metadata.suggestionGeneratedAt}
                          </p>
                        ) : null}

                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-stone-400">Summary</p>
                          <p className="mt-1 text-sm leading-6 text-stone-700">{suggestFixState.data.summary}</p>
                        </div>

                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-stone-400">Draft Language</p>
                          <div className="mt-1 rounded border border-stone-200 bg-white px-3 py-3">
                            <pre className="whitespace-pre-wrap text-sm leading-6 text-stone-800">
                              {suggestFixContent.draftLanguage || 'No draft language was returned.'}
                            </pre>
                          </div>
                        </div>

                        {suggestFixContent.implementationNotes.length ? (
                          <div>
                            <p className="text-[11px] uppercase tracking-wide text-stone-400">Implementation Notes</p>
                            <div className="mt-1 rounded border border-stone-200 bg-white px-3 py-3">
                              <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-stone-800">
                                {suggestFixContent.implementationNotes.map((note) => (
                                  <li key={note}>{note}</li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        ) : null}

                        <div>
                          <p className="text-[11px] uppercase tracking-wide text-stone-400">Policy Health</p>
                          {suggestFixState.data.policyHealth ? (
                            <div className="mt-1 space-y-3 rounded border border-stone-200 bg-white px-3 py-3">
                              {suggestFixState.data.metadata?.policyHealthGeneratedAt ? (
                                <p className="text-[11px] text-stone-500">
                                  {suggestFixState.data.metadata?.policyHealthSource === 'cache_hit' ? 'Cached at' : 'Generated at'} {formatDate(suggestFixState.data.metadata.policyHealthGeneratedAt) || suggestFixState.data.metadata.policyHealthGeneratedAt}
                                </p>
                              ) : null}
                              <p className="text-sm leading-6 text-stone-700">{suggestFixState.data.policyHealth.summary}</p>
                              {policyHealthFindings.length ? (
                                <div className="space-y-2">
                                  {policyHealthFindings.map((finding, index) => (
                                    <div key={`${finding.type}-${finding.issue}-${index}`} className="rounded border border-stone-200 bg-stone-50 px-3 py-3">
                                      <div className="flex flex-wrap gap-2">
                                        <MetaPill label={`Severity: ${formatLabel(finding.severity)}`} tone={getFindingTone(finding.severity)} />
                                        <MetaPill label={formatFindingType(finding.type)} />
                                        {finding.staleCitation ? <MetaPill label="Stale Citation" tone="red" /> : null}
                                        {finding.abbreviationDiscipline ? <MetaPill label="Abbreviation Discipline" tone="indigo" /> : null}
                                        {finding.definedTermDiscipline ? <MetaPill label="Defined-Term Discipline" tone="indigo" /> : null}
                                      </div>
                                      <p className="mt-2 text-sm leading-6 text-stone-800">{finding.issue}</p>
                                      {finding.suggestedInsertionPoint ? (
                                        <p className="mt-2 text-xs leading-5 text-stone-500">
                                          Suggested insertion point: {finding.suggestedInsertionPoint}
                                        </p>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-sm text-stone-500">No specific policy-health findings were returned.</p>
                              )}
                            </div>
                          ) : (
                            <p className="mt-1 text-sm text-stone-500">
                              No matched policy was available, so the suggestion focuses on best-effort remediation guidance.
                            </p>
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="rounded border border-stone-200 bg-white px-3 py-2.5">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-stone-900">Confirm result</p>
                      <p className="text-xs text-stone-500">
                        Mark the current result as correct.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={actionsDisabled}
                      onClick={() => submitReview({
                        disposition: 'confirmed',
                        note: review?.note ?? null,
                      }, 'confirmed')}
                      className="inline-flex w-full items-center justify-center rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                    >
                      {mutationState.action === 'confirmed' ? 'Confirming...' : 'Confirm Result'}
                    </button>
                  </div>
                </div>

                <DisclosureSection
                  title="Reviewer-corrected status"
                  helper="Use when the engine status is wrong and you want to record the corrected result."
                  open={activeActionPanel === 'override'}
                  onToggle={() => setActiveActionPanel((current) => (current === 'override' ? null : 'override'))}
                >
                  <form
                    className="space-y-3"
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
                      <span className="text-[11px] text-stone-400">Optional note</span>
                      <textarea
                        value={overrideNote}
                        onChange={(event) => setOverrideNote(event.target.value)}
                        rows={2}
                        disabled={actionsDisabled}
                        className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                        placeholder="Why the status is being corrected"
                      />
                    </label>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-[11px] text-stone-400">
                        {!overrideStatus ? 'Choose the corrected status first.' : 'This records the reviewer-corrected outcome.'}
                      </p>
                      <button
                        type="submit"
                        disabled={actionsDisabled || !overrideStatus}
                        className="inline-flex w-full items-center justify-center rounded bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      >
                        {mutationState.action === 'overridden' ? 'Saving...' : 'Save Corrected Status'}
                      </button>
                    </div>
                  </form>
                </DisclosureSection>

                <DisclosureSection
                  title="Flag as engine issue"
                  helper="Use when this looks like an engine mistake, not real remediation work."
                  open={activeActionPanel === 'defect'}
                  onToggle={() => setActiveActionPanel((current) => (current === 'defect' ? null : 'defect'))}
                >
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();

                      submitReview({
                        disposition: 'flagged_engine_defect',
                        defectClass: toOptionalString(defectClass),
                        note: toOptionalString(defectNote),
                      }, 'flagged_engine_defect');
                    }}
                  >
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
                      <span className="text-[11px] text-stone-400">Optional note</span>
                      <textarea
                        value={defectNote}
                        onChange={(event) => setDefectNote(event.target.value)}
                        rows={2}
                        disabled={actionsDisabled}
                        className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                        placeholder="What looks wrong in the engine behavior"
                      />
                    </label>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-[11px] text-stone-400">Flagged rows drop out of the default remediation list.</p>
                      <button
                        type="submit"
                        disabled={actionsDisabled}
                        className="inline-flex w-full items-center justify-center rounded bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      >
                        {mutationState.action === 'flagged_engine_defect' ? 'Saving...' : 'Mark Engine Issue'}
                      </button>
                    </div>
                  </form>
                </DisclosureSection>

                <DisclosureSection
                  title="Dismiss from review queue"
                  helper="Use when this item does not need reviewer follow-up right now."
                  open={activeActionPanel === 'dismiss'}
                  onToggle={() => setActiveActionPanel((current) => (current === 'dismiss' ? null : 'dismiss'))}
                >
                  <form
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();

                      submitReview({
                        disposition: 'dismissed',
                        dismissReason: toOptionalString(dismissReason),
                        note: toOptionalString(dismissNote),
                      }, 'dismissed');
                    }}
                  >
                    <label className="space-y-1">
                      <span className="text-[11px] text-stone-400">Optional reason</span>
                      <input
                        value={dismissReason}
                        onChange={(event) => setDismissReason(event.target.value)}
                        disabled={actionsDisabled}
                        className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                        placeholder="Reason for dismissing"
                      />
                    </label>

                    <label className="space-y-1">
                      <span className="text-[11px] text-stone-400">Optional note</span>
                      <textarea
                        value={dismissNote}
                        onChange={(event) => setDismissNote(event.target.value)}
                        rows={2}
                        disabled={actionsDisabled}
                        className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                        placeholder="Why review is being dismissed"
                      />
                    </label>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-[11px] text-stone-400">Dismissed items stay visible unless other filters remove them.</p>
                      <button
                        type="submit"
                        disabled={actionsDisabled}
                        className="inline-flex w-full items-center justify-center rounded bg-stone-700 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      >
                        {mutationState.action === 'dismissed' ? 'Saving...' : 'Dismiss Item'}
                      </button>
                    </div>
                  </form>
                </DisclosureSection>
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

              <section className="card space-y-4 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-stone-900">Policy Link</h3>
                    <p className="text-xs text-stone-500">Canonical linkage provenance plus reviewer-managed relinking</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <MetaPill label={policyLinkStatus.label} tone={policyLinkStatus.tone} />
                    {policyLink?.hasExplicitLink ? (
                      <MetaPill label="Explicit link saved" />
                    ) : (
                      <MetaPill label="No explicit link saved" tone="stone" />
                    )}
                  </div>
                </div>

                <p className="text-sm leading-6 text-stone-700">{policyLinkStatus.helper}</p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <InfoRow label="Effective Policy Number" value={policyLink?.effectivePolicyNumber} />
                  <InfoRow label="Effective Policy Title" value={policyLink?.effectivePolicyTitle} />
                  <InfoRow label="Legacy Covering Policy Number" value={policyLink?.legacyCoveringPolicyNumber} />
                  <InfoRow label="Linked By" value={policyLink?.linkedBy} />
                </div>

                {policyLink?.note ? <InfoRow label="Link Note" value={policyLink.note} /> : null}

                {!policyLink?.hasEffectivePolicy ? (
                  <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    No resolved matched policy is attached right now. Saving a reviewer-selected policy here will create the canonical link explicitly.
                  </div>
                ) : null}

                {policyLinkMutationState.error ? (
                  <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {policyLinkMutationState.error}
                  </div>
                ) : null}

                <form className="space-y-3" onSubmit={savePolicyLink}>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <input
                      value={policySearchTerm}
                      onChange={(event) => setPolicySearchTerm(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          searchPolicies();
                        }
                      }}
                      disabled={policyLinkActionsDisabled}
                      placeholder="Search by policy number or title"
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      onClick={searchPolicies}
                      disabled={policyLinkActionsDisabled}
                      className="inline-flex w-full items-center justify-center rounded border border-stone-200 px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                    >
                      {policySearchState.loading ? 'Searching...' : 'Search Policies'}
                    </button>
                  </div>

                  {policySearchState.error ? (
                    <p className="text-sm text-red-700">{policySearchState.error}</p>
                  ) : null}

                  {policySearchState.hasSearched && !policySearchState.loading && !policySearchState.results.length ? (
                    <p className="text-sm text-stone-500">
                      No numbered indexed policies matched this search.
                    </p>
                  ) : null}

                  {policySearchState.results.length ? (
                    <div className="max-h-56 overflow-y-auto rounded border border-stone-200">
                      <div className="divide-y divide-stone-100">
                        {policySearchState.results.map((result) => {
                          const isSelected = result.id === selectedPolicyId;
                          return (
                            <button
                              key={result.id}
                              type="button"
                              onClick={() => setSelectedPolicyId(result.id)}
                              className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left ${isSelected ? 'bg-stone-900 text-white' : 'hover:bg-stone-50'}`}
                            >
                              <div className="min-w-0">
                                <p className={`truncate text-sm font-medium ${isSelected ? 'text-white' : 'text-stone-900'}`}>
                                  {result.policyNumber}
                                </p>
                                <p className={`truncate text-xs ${isSelected ? 'text-stone-300' : 'text-stone-500'}`}>
                                  {result.title}
                                </p>
                              </div>
                              <div className="text-right text-[11px]">
                                <p className={isSelected ? 'text-stone-300' : 'text-stone-500'}>
                                  {result.domain || '-'}
                                </p>
                                <p className={isSelected ? 'text-white' : 'text-stone-700'}>
                                  {isSelected ? 'Selected' : 'Select'}
                                </p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {selectedPolicyPreview ? (
                    <div className="rounded border border-stone-200 bg-stone-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-stone-400">Selected To Save</p>
                      <p className="mt-1 text-sm font-medium text-stone-900">
                        {selectedPolicyPreview.policyNumber} {selectedPolicyPreview.title ? ` - ${selectedPolicyPreview.title}` : ''}
                      </p>
                      {(selectedPolicyPreview.domain || selectedPolicyPreview.subDomain) ? (
                        <p className="mt-1 text-[11px] text-stone-500">
                          {[selectedPolicyPreview.domain, selectedPolicyPreview.subDomain].filter(Boolean).join(' / ')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <label className="space-y-1">
                    <span className="text-[11px] text-stone-400">Optional reviewer note</span>
                    <textarea
                      value={policyLinkNote}
                      onChange={(event) => setPolicyLinkNote(event.target.value)}
                      rows={2}
                      disabled={policyLinkActionsDisabled}
                      className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                      placeholder="Why this policy is the right canonical link"
                    />
                  </label>

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-[11px] text-stone-400">
                      {selectedPolicyId
                        ? 'Saving here writes reviewer_selected to assessment_policy_links and refreshes the current group.'
                        : 'Search and select a policy to save a reviewer-owned canonical link.'}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      {policyLink?.hasExplicitLink ? (
                        <button
                          type="button"
                          onClick={clearPolicyLink}
                          disabled={policyLinkActionsDisabled}
                          className="inline-flex w-full items-center justify-center rounded border border-stone-200 px-3 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                        >
                          {policyLinkMutationState.action === 'clear' ? 'Clearing...' : 'Clear Explicit Link'}
                        </button>
                      ) : null}
                      <button
                        type="submit"
                        disabled={policyLinkActionsDisabled || !selectedPolicyId}
                        className="inline-flex w-full items-center justify-center rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      >
                        {policyLinkMutationState.action === 'save' ? 'Saving...' : 'Save Policy Link'}
                      </button>
                    </div>
                  </div>
                </form>
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
                        <MetaPill label={formatLabel(defect.status)} tone={getDefectLifecycleTone(defect.status)} />
                      </div>
                      <InfoRow label="Severity" value={defect.severity} />
                      <InfoRow label="Owner" value={defect.owner} />
                      <InfoRow label="Seeded From" value={defect.seeded_from} />
                      <InfoRow label="Updated At" value={formatDate(defect.updated_at)} />
                      <InfoRow label="Resolved At" value={formatDate(defect.resolved_at)} />
                      <InfoRow label="Note" value={defect.note} />
                    </>
                  ) : (
                    <p className="text-sm text-stone-500">No system defect is attached to this assessment.</p>
                  )}
                </div>
              </section>

              <section className="card space-y-4 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-stone-900">Defect Lifecycle</h3>
                    <p className="text-xs text-stone-500">Triage owner, status, severity, and resolution state for the current defect row.</p>
                  </div>
                  {defect ? (
                    <div className="flex flex-wrap gap-2">
                      <MetaPill label={`Review: ${formatLabel(review?.disposition || 'unreviewed')}`} tone="indigo" />
                      <MetaPill label={`Queue: ${formatLabel(defect.status)}`} tone={getDefectLifecycleTone(defect.status)} />
                    </div>
                  ) : null}
                </div>

                <div className="rounded border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700">
                  {defect ? (
                    review?.disposition === 'flagged_engine_defect'
                      ? 'Review disposition explains why this assessment left the normal remediation path. Defect lifecycle tracks separate triage and resolution work, so changing queue status here does not rewrite the review record.'
                      : `This assessment still has a defect row even though the current review disposition is ${formatLabel(review?.disposition || 'unreviewed')}. That is intentional compatibility behavior: resolve or reopen the defect separately instead of assuming the review record will clear it.`
                  ) : (
                    'Lifecycle controls become available after a reviewer flags this assessment as an engine issue and a system_defects row exists.'
                  )}
                </div>

                {defectMutationState.error ? (
                  <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {defectMutationState.error}
                  </div>
                ) : null}

                {defect ? (
                  <form className="space-y-3" onSubmit={saveDefectLifecycle}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-stone-400">Queue Status</span>
                        <select
                          value={defectLifecycleStatus}
                          onChange={(event) => setDefectLifecycleStatus(event.target.value)}
                          disabled={defectLifecycleDisabled}
                          className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                        >
                          {DEFECT_LIFECYCLE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>

                      <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-stone-400">Severity</span>
                        <select
                          value={defectSeverity}
                          onChange={(event) => setDefectSeverity(event.target.value)}
                          disabled={defectLifecycleDisabled}
                          className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                        >
                          {DEFECT_SEVERITY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-[11px] uppercase tracking-wide text-stone-400">Owner</span>
                        <input
                          value={defectOwner}
                          onChange={(event) => setDefectOwner(event.target.value)}
                          disabled={defectLifecycleDisabled}
                          className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                          placeholder="Assign owner"
                        />
                      </label>

                      <div className="rounded border border-stone-200 bg-stone-50 px-3 py-2">
                        <p className="text-[11px] uppercase tracking-wide text-stone-400">Resolution Timing</p>
                        <p className="mt-1 text-sm text-stone-700">
                          Saving Fixed or Won't Fix sets the resolution timestamp automatically. Moving back to Open or Acknowledged clears it.
                        </p>
                      </div>
                    </div>

                    <label className="space-y-1">
                      <span className="text-[11px] uppercase tracking-wide text-stone-400">Lifecycle Note</span>
                      <textarea
                        value={defectLifecycleNote}
                        onChange={(event) => setDefectLifecycleNote(event.target.value)}
                        rows={3}
                        disabled={defectLifecycleDisabled}
                        className="w-full rounded border border-stone-200 bg-white px-3 py-2 text-sm"
                        placeholder="Triage context, owner handoff, or resolution note"
                      />
                    </label>

                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-[11px] text-stone-400">
                        This updates the existing defect row only. It does not change the assessment review disposition.
                      </p>
                      <button
                        type="submit"
                        disabled={defectLifecycleDisabled}
                        className="inline-flex w-full items-center justify-center rounded bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
                      >
                        {defectMutationState.action === 'save' ? 'Saving...' : 'Save Defect Lifecycle'}
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>
            </>
          ) : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
