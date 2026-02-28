import { useState, useEffect, useCallback } from 'react';
import { Badge, FilterPill, StatCard, Spinner, EmptyState, exportCSV, STATES } from './shared';

const TIER_LABELS = {
  critical: { label: 'Critical', color: 'text-red-700', bg: 'bg-red-50', ring: 'ring-red-200' },
  operational: { label: 'Operational', color: 'text-amber-700', bg: 'bg-amber-50', ring: 'ring-amber-200' },
  facility_physical: { label: 'Facility/Physical', color: 'text-blue-700', bg: 'bg-blue-50', ring: 'ring-blue-200' },
  licensing_admin: { label: 'Licensing/Admin', color: 'text-stone-600', bg: 'bg-stone-50', ring: 'ring-stone-200' },
  not_applicable: { label: 'N/A', color: 'text-stone-400', bg: 'bg-stone-50', ring: 'ring-stone-200' },
  unclassified: { label: 'Unclassified', color: 'text-stone-400', bg: 'bg-stone-50', ring: 'ring-stone-200' },
};

function TierBadge({ tier }) {
  const t = TIER_LABELS[tier] || TIER_LABELS.unclassified;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${t.bg} ${t.color} ring-1 ${t.ring}`}>
      {t.label}
    </span>
  );
}

export default function GapReportMode() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('GAP');
  const [stateFilter, setStateFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [bulkWorking, setBulkWorking] = useState(false);
  const [selectAll, setSelectAll] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [reviewingId, setReviewingId] = useState(null);

  const fetchGaps = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('status', filter);
    if (stateFilter !== 'all') params.set('state', stateFilter);
    if (tierFilter !== 'all') params.set('risk_tier', tierFilter);
    fetch(`/api/v6/gaps?${params}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); setSelected(new Set()); setSelectAll(false); })
      .catch(() => setLoading(false));
  }, [filter, stateFilter, tierFilter]);

  useEffect(() => { fetchGaps(); }, [fetchGaps]);

  const filtered = (data?.rows || []).filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.citation?.toLowerCase().includes(q) || r.requirement?.toLowerCase().includes(q) || r.gap_detail?.toLowerCase().includes(q);
  });

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectAll) {
      setSelected(new Set());
      setSelectAll(false);
    } else {
      setSelected(new Set(filtered.filter(r => r.assessment_id).map(r => r.assessment_id)));
      setSelectAll(true);
    }
  };

  const bulkMark = async (status, label) => {
    if (selected.size === 0) return;
    if (!confirm(`Mark ${selected.size} items as ${label || status}?`)) return;
    setBulkWorking(true);
    try {
      const res = await fetch('/api/v6/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assessment_ids: [...selected],
          human_status: status,
          review_notes: `Bulk marked ${label || status} — ${tierFilter !== 'all' ? tierFilter + ' tier' : 'manual selection'}`,
          reviewed_by: 'clo',
        }),
      });
      if (res.ok) fetchGaps();
    } catch (err) {
      console.error('Bulk review error:', err);
    }
    setBulkWorking(false);
  };

  const handleSingleReview = async (assessmentId, humanStatus, notes) => {
    await fetch('/api/v6/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assessment_id: assessmentId, human_status: humanStatus, review_notes: notes }),
    });
    fetchGaps();
    setReviewingId(null);
  };

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Gap Report</h1>
        <p className="text-sm text-stone-500">Filterable compliance gaps across all regulatory sources</p>
      </div>

      {data?.summary && (
        <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
          <StatCard label="Total" value={data.summary.total} />
          <StatCard label="Covered" value={data.summary.covered} color="text-emerald-700" />
          <StatCard label="Partial" value={data.summary.partial} color="text-amber-700" />
          <StatCard label="Gaps" value={data.summary.gap} color="text-red-700" />
          <StatCard label="Conflicting" value={data.summary.conflicting || 0} color="text-purple-700" />
          <StatCard label="Unassessed" value={data.summary.unassessed} />
          <StatCard label="Reviewed" value={data.summary.human_reviewed} color="text-indigo-700" />
        </div>
      )}

      {/* Tier filter bar */}
      {data?.tierCounts && Object.keys(data.tierCounts).length > 0 && (
        <div className="flex flex-wrap gap-2">
          <span className="text-xs text-stone-400 py-1">Risk Tier:</span>
          <button onClick={() => setTierFilter('all')} className={`px-2 py-0.5 text-xs rounded-full ${tierFilter === 'all' ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
            All
          </button>
          {['critical', 'operational', 'facility_physical', 'licensing_admin', 'not_applicable'].map(t => {
            const count = data.tierCounts[t] || 0;
            if (count === 0 && tierFilter !== t) return null;
            const tl = TIER_LABELS[t];
            return (
              <button key={t} onClick={() => setTierFilter(t)} className={`px-2 py-0.5 text-xs rounded-full ${tierFilter === t ? 'bg-stone-900 text-white' : `${tl.bg} ${tl.color} ring-1 ${tl.ring} hover:opacity-80`}`}>
                {tl.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Status filter + search */}
      <div className="flex flex-wrap items-center gap-2">
        {['GAP', 'PARTIAL', 'COVERED', 'CONFLICTING', 'UNASSESSED', 'all'].map(s => (
          <FilterPill key={s} active={filter === s} label={s === 'all' ? 'All' : s} onClick={() => setFilter(s)} />
        ))}
        <span className="text-stone-300">|</span>
        <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} className="text-xs border border-stone-200 rounded px-2 py-1 bg-white">
          <option value="all">All States</option>
          {STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search..."
          className="text-xs border border-stone-200 rounded px-2 py-1 bg-white flex-1 min-w-[200px]"
        />
        {filtered.length > 0 && (
          <button onClick={() => exportCSV(filtered)} className="px-3 py-1 text-xs border border-stone-200 rounded bg-white hover:bg-stone-50">Export CSV</button>
        )}
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-2 bg-indigo-50 rounded-lg border border-indigo-200">
          <span className="text-xs font-medium text-indigo-700">{selected.size} selected</span>
          <button onClick={() => bulkMark('NOT_APPLICABLE', 'N/A')} disabled={bulkWorking} className="px-2 py-1 text-xs bg-stone-600 text-white rounded hover:bg-stone-700 disabled:opacity-50">
            {bulkWorking ? 'Working...' : 'Mark N/A'}
          </button>
          <button onClick={() => bulkMark('COVERED', 'Covered')} disabled={bulkWorking} className="px-2 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">
            Mark Covered
          </button>
          <button onClick={() => bulkMark('GAP', 'Gap')} disabled={bulkWorking} className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
            Mark Gap
          </button>
          <button onClick={() => { setSelected(new Set()); setSelectAll(false); }} className="px-2 py-1 text-xs text-stone-500 hover:text-stone-700">
            Clear
          </button>
        </div>
      )}

      {loading ? <Spinner /> : (
        <div className="card divide-y divide-stone-100">
          <div className="px-4 py-2 bg-stone-50 rounded-t-lg border-b border-stone-200 flex items-center text-xs font-medium text-stone-500">
            <span className="w-5 flex-shrink-0">
              <input type="checkbox" checked={selectAll} onChange={toggleSelectAll} className="rounded" />
            </span>
            <span className="w-16 flex-shrink-0">Status</span>
            <span className="w-24 flex-shrink-0">Tier</span>
            <span className="w-32 flex-shrink-0">Citation</span>
            <span className="flex-1 min-w-0">Requirement</span>
            <span className="w-20 flex-shrink-0 text-right">Policy</span>
          </div>
          {filtered.length === 0 && <EmptyState message="No results match filters" />}
          {filtered.slice(0, 300).map((row, i) => {
            const isExpanded = expandedId === (row.obligation_id || i);
            const isReviewing = reviewingId === (row.obligation_id || i);

            return (
              <div key={row.obligation_id || i}>
                <div className={`px-4 py-2.5 flex items-start gap-0 ${selected.has(row.assessment_id) ? 'bg-indigo-50/50' : ''}`}>
                  <span className="w-5 pt-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                    {row.assessment_id && (
                      <input type="checkbox" checked={selected.has(row.assessment_id)} onChange={() => toggleSelect(row.assessment_id)} className="rounded" />
                    )}
                  </span>
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : (row.obligation_id || i))}
                    className="flex items-start gap-0 flex-1 min-w-0 text-left row-hover rounded px-0 py-0"
                  >
                    <span className="w-16 pt-0.5 flex-shrink-0"><Badge status={row.human_status || row.status} /></span>
                    <span className="w-24 pt-0.5 flex-shrink-0"><TierBadge tier={row.risk_tier} /></span>
                    <span className="w-32 flex-shrink-0 text-xs font-mono text-stone-600 pt-0.5">{row.citation}</span>
                    <span className="flex-1 min-w-0 text-sm text-stone-800 line-clamp-2 pr-2">{row.requirement}</span>
                    <span className="w-20 flex-shrink-0 text-xs text-stone-500 text-right">{row.recommended_policy || row.policy_number || '—'}</span>
                  </button>
                </div>

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div className="px-4 pb-4 bg-stone-50 border-t border-stone-100">
                    <div className="ml-5 grid grid-cols-2 gap-4 text-xs mt-3">
                      <div>
                        <p className="font-medium text-stone-500 mb-1">Source</p>
                        <p>{row.source_name} ({row.source_state || 'All'})</p>
                      </div>
                      <div>
                        <p className="font-medium text-stone-500 mb-1">Assessment</p>
                        <p>
                          <Badge status={row.status} />
                          {row.confidence && <span className="ml-2 text-stone-400">({row.confidence})</span>}
                          {row.match_method && <span className="ml-2 text-stone-400">via {row.match_method}</span>}
                          {row.match_score && <span className="text-stone-400"> (score: {row.match_score})</span>}
                        </p>
                      </div>
                      {row.gap_detail && (
                        <div className="col-span-2">
                          <p className="font-medium text-stone-500 mb-1">Gap Detail</p>
                          <p className="text-stone-700 bg-white p-2 rounded border border-stone-200">{row.gap_detail}</p>
                        </div>
                      )}
                      {row.reasoning && (
                        <div className="col-span-2">
                          <p className="font-medium text-stone-500 mb-1">Reasoning</p>
                          <p className="text-stone-600 bg-white p-2 rounded border border-stone-200">{row.reasoning}</p>
                        </div>
                      )}
                      {row.policy_number && (
                        <div>
                          <p className="font-medium text-stone-500 mb-1">Covering Policy</p>
                          <p>{row.policy_number}{row.policy_title && ` — ${row.policy_title}`}</p>
                        </div>
                      )}
                      {row.recommended_policy && row.recommended_policy !== row.policy_number && (
                        <div>
                          <p className="font-medium text-stone-500 mb-1">Recommended Policy</p>
                          <p>{row.recommended_policy}</p>
                        </div>
                      )}
                      {row.risk_tier && (
                        <div>
                          <p className="font-medium text-stone-500 mb-1">Risk Tier</p>
                          <TierBadge tier={row.risk_tier} />
                        </div>
                      )}
                      {row.human_status && (
                        <div className="col-span-2">
                          <p className="font-medium text-indigo-600 mb-1">Human Review</p>
                          <p>
                            <Badge status={row.human_status} />
                            {row.review_notes && <span className="ml-2 text-stone-600">{row.review_notes}</span>}
                          </p>
                          <p className="text-stone-400 mt-1">
                            {row.reviewed_by && `By ${row.reviewed_by}`}
                            {row.reviewed_at && ` · ${new Date(row.reviewed_at).toLocaleDateString()}`}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Single-item review controls */}
                    {row.assessment_id && !isReviewing && (
                      <button
                        onClick={() => setReviewingId(row.obligation_id || i)}
                        className="ml-5 mt-3 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                      >
                        {row.human_status ? 'Update Review' : 'Add Human Review'}
                      </button>
                    )}
                    {isReviewing && (
                      <div className="ml-5">
                        <ReviewForm
                          assessmentId={row.assessment_id}
                          currentStatus={row.human_status || row.status}
                          currentNotes={row.review_notes}
                          onSubmit={handleSingleReview}
                          onCancel={() => setReviewingId(null)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length > 300 && (
            <div className="px-4 py-3 text-xs text-stone-400 text-center">Showing first 300 of {filtered.length} results</div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewForm({ assessmentId, currentStatus, currentNotes, onSubmit, onCancel }) {
  const [status, setStatus] = useState(currentStatus || 'GAP');
  const [notes, setNotes] = useState(currentNotes || '');

  return (
    <div className="mt-3 p-3 bg-white border border-indigo-100 rounded-lg" onClick={e => e.stopPropagation()}>
      <p className="text-xs font-medium text-indigo-700 mb-2">Human Review</p>
      <div className="flex gap-2 mb-2">
        {['COVERED', 'PARTIAL', 'GAP', 'NOT_APPLICABLE'].map(s => (
          <button key={s} onClick={() => setStatus(s)} className={`px-2 py-1 rounded text-xs font-medium transition-colors ${status === s ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'}`}>
            {s === 'NOT_APPLICABLE' ? 'N/A' : s}
          </button>
        ))}
      </div>
      <textarea
        value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Review notes (optional)..."
        className="w-full text-xs border border-stone-200 rounded p-2 h-16 resize-none"
      />
      <div className="flex gap-2 mt-2">
        <button onClick={() => onSubmit(assessmentId, status, notes)} className="px-3 py-1 bg-indigo-600 text-white text-xs font-medium rounded hover:bg-indigo-700">Save Review</button>
        <button onClick={onCancel} className="px-3 py-1 text-xs text-stone-500 hover:text-stone-700">Cancel</button>
      </div>
    </div>
  );
}
