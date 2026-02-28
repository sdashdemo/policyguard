import { useState, useEffect } from 'react';
import { Badge, CoverageBar, StatCard, FilterPill, Spinner, EmptyState, STATUS_COLORS } from './shared';

export default function FacilityViewMode({ facilityId, onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [reviewingId, setReviewingId] = useState(null);

  // Facility picker state (when no facilityId)
  const [facilities, setFacilities] = useState([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [localFacilityId, setLocalFacilityId] = useState(facilityId);

  const activeFacilityId = localFacilityId || facilityId;

  // Reset local selection when prop changes
  useEffect(() => { setLocalFacilityId(facilityId); }, [facilityId]);

  // Load facility list if no facility selected
  useEffect(() => {
    if (activeFacilityId) return;
    setPickerLoading(true);
    fetch('/api/v6/dashboard')
      .then(r => r.json())
      .then(d => {
        setFacilities(d.facilities || []);
        setPickerLoading(false);
      })
      .catch(() => setPickerLoading(false));
  }, [activeFacilityId]);

  // Load facility detail when selected
  useEffect(() => {
    if (!activeFacilityId) { setLoading(false); return; }
    setLoading(true);
    fetch(`/api/v6/facilities?id=${activeFacilityId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => { setData(null); setLoading(false); });
  }, [activeFacilityId]);

  const handleReview = async (assessmentId, humanStatus, notes) => {
    await fetch('/api/v6/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assessment_id: assessmentId, human_status: humanStatus, review_notes: notes }),
    });
    const d = await fetch(`/api/v6/facilities?id=${activeFacilityId}`).then(r => r.json());
    setData(d);
    setReviewingId(null);
  };

  // ─── Facility Picker ───────────────────────────────
  if (!activeFacilityId) {
    if (pickerLoading) return <Spinner />;

    const byState = {};
    for (const f of facilities) {
      const st = f.state || 'Unknown';
      if (!byState[st]) byState[st] = [];
      byState[st].push(f);
    }

    return (
      <div className="page-enter space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Facility View</h1>
          <p className="text-sm text-stone-500">Select a facility to view compliance details</p>
        </div>

        {Object.keys(byState).sort().map(state => (
          <div key={state}>
            <h2 className="text-xs font-semibold text-stone-400 uppercase tracking-wider mb-2 mt-4">{state}</h2>
            <div className="card divide-y divide-stone-100">
              {byState[state].map(f => {
                const covered = Number(f.covered || 0);
                const partial = Number(f.partial || 0);
                const gaps = Number(f.gaps || 0);
                const assessed = covered + partial + gaps;
                return (
                  <button
                    key={f.facility_id || f.id}
                    onClick={() => setLocalFacilityId(f.facility_id || f.id)}
                    className="w-full px-4 py-3 row-hover text-left flex items-center gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold">{f.abbreviation || f.name}</p>
                      <p className="text-xs text-stone-500 mt-0.5 truncate">{f.name}</p>
                      <p className="text-xs text-stone-400 mt-0.5">
                        {Array.isArray(f.levels_of_care) ? f.levels_of_care.join(', ') : 'No LOC configured'}
                      </p>
                    </div>
                    <div className="w-48 flex-shrink-0 text-right">
                      {assessed > 0 ? (
                        <>
                          <p className="text-xs tabular-nums">
                            <span className="text-emerald-600">{covered}</span>
                            {' / '}
                            <span className="text-amber-600">{partial}</span>
                            {' / '}
                            <span className="text-red-600">{gaps}</span>
                          </p>
                          <div className="mt-1">
                            <CoverageBar covered={covered} partial={partial} gaps={gaps} total={assessed} />
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-stone-400">Org-level data</p>
                      )}
                    </div>
                    <span className="text-stone-300 text-sm">→</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {facilities.length === 0 && (
          <EmptyState message="No facilities configured. Add facilities in Facility Matrix." />
        )}
      </div>
    );
  }

  // ─── Facility Detail ───────────────────────────────
  if (loading) return <Spinner />;

  if (!data?.facility) {
    return (
      <div className="page-enter space-y-4">
        <button onClick={() => setLocalFacilityId(null)} className="text-xs text-stone-400 hover:text-stone-700">← All Facilities</button>
        <EmptyState message="Facility not found" />
      </div>
    );
  }

  const fac = data.facility;
  const obls = data.obligations || [];
  const sources = [...new Set(obls.map(o => o.source_name))].sort();

  let filtered = obls;
  if (filter !== 'all') {
    if (filter === 'UNASSESSED') filtered = filtered.filter(o => !o.status);
    else filtered = filtered.filter(o => o.status === filter);
  }
  if (sourceFilter !== 'all') filtered = filtered.filter(o => o.source_name === sourceFilter);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(o => o.citation?.toLowerCase().includes(q) || o.requirement?.toLowerCase().includes(q));
  }

  const counts = {
    total: obls.length,
    covered: obls.filter(o => o.status === 'COVERED').length,
    partial: obls.filter(o => o.status === 'PARTIAL').length,
    gap: obls.filter(o => o.status === 'GAP').length,
    conflicting: obls.filter(o => o.status === 'CONFLICTING').length,
    unassessed: obls.filter(o => !o.status).length,
    reviewed: obls.filter(o => o.human_status).length,
  };

  const assessed = counts.covered + counts.partial + counts.gap + counts.conflicting;

  return (
    <div className="page-enter space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => setLocalFacilityId(null)} className="text-xs text-stone-400 hover:text-stone-700 mb-1">← All Facilities</button>
          <h1 className="text-xl font-semibold">{fac.name}</h1>
          <p className="text-sm text-stone-500">{fac.state} · {(fac.levels_of_care || []).join(', ') || 'No LOC configured'}</p>
        </div>
      </div>

      {assessed === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-stone-600 font-medium">No facility-level assessments yet</p>
          <p className="text-xs text-stone-400 mt-2">
            Assessments ran at org level. Showing all obligations from <strong>{fac.state}</strong> regulatory sources below.
            {obls.length > 0
              ? ` ${obls.length} obligations from ${sources.length} source${sources.length !== 1 ? 's' : ''} apply.`
              : ' No regulatory sources loaded for this state yet.'}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
            <StatCard label="Total" value={counts.total} />
            <StatCard label="Covered" value={counts.covered} color="text-emerald-700" />
            <StatCard label="Partial" value={counts.partial} color="text-amber-700" />
            <StatCard label="Gaps" value={counts.gap} color="text-red-700" />
            <StatCard label="Conflicting" value={counts.conflicting} color="text-purple-700" />
            <StatCard label="Unassessed" value={counts.unassessed} />
            <StatCard label="Reviewed" value={counts.reviewed} color="text-indigo-700" />
          </div>
          <CoverageBar covered={counts.covered} partial={counts.partial} gaps={counts.gap} total={assessed} />
        </>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {['all', 'GAP', 'PARTIAL', 'COVERED', 'CONFLICTING', 'UNASSESSED'].map(s => (
          <FilterPill key={s} active={filter === s} label={s === 'all' ? `All (${obls.length})` : `${s} (${s === 'UNASSESSED' ? counts.unassessed : counts[s.toLowerCase()] || 0})`} onClick={() => setFilter(s)} />
        ))}
        <span className="text-stone-300">|</span>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="text-xs border border-stone-200 rounded px-2 py-1 bg-white">
          <option value="all">All Sources ({sources.length})</option>
          {sources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search obligations..."
          className="text-xs border border-stone-200 rounded px-2 py-1 bg-white flex-1 min-w-[200px]"
        />
      </div>

      {/* Obligations list */}
      <div className="card divide-y divide-stone-100">
        <div className="px-4 py-2 bg-stone-50 rounded-t-lg border-b border-stone-200 flex items-center text-xs font-medium text-stone-500">
          <span className="w-10">Status</span>
          <span className="w-48 ml-2">Citation</span>
          <span className="flex-1 ml-2">Requirement</span>
          <span className="w-32 ml-2 text-right">Covering Policy</span>
        </div>
        {filtered.length === 0 && <EmptyState message="No obligations match filters" />}
        {filtered.slice(0, 200).map(obl => {
          const isExpanded = expandedId === obl.id;
          const isReviewing = reviewingId === obl.id;
          const effectiveStatus = obl.human_status || obl.status;

          return (
            <div key={obl.id}>
              <button
                onClick={() => setExpandedId(isExpanded ? null : obl.id)}
                className="w-full px-4 py-2.5 row-hover flex items-start text-left gap-2"
              >
                <span className="w-10 pt-0.5 flex-shrink-0"><Badge status={effectiveStatus} /></span>
                <span className="w-48 flex-shrink-0 text-xs font-mono text-stone-600 pt-0.5">{obl.citation}</span>
                <span className="flex-1 text-sm text-stone-800 line-clamp-2">{obl.requirement}</span>
                <span className="w-32 flex-shrink-0 text-xs text-stone-500 text-right pt-0.5">
                  {obl.policy_number || '—'}
                </span>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 bg-stone-50 border-t border-stone-100">
                  <div className="grid grid-cols-2 gap-4 text-xs mt-3">
                    <div>
                      <p className="font-medium text-stone-500 mb-1">Source</p>
                      <p>{obl.source_name} ({obl.source_state || 'All'})</p>
                    </div>
                    <div>
                      <p className="font-medium text-stone-500 mb-1">LLM Assessment</p>
                      <p>{obl.status ? <Badge status={obl.status} /> : 'Not assessed'} {obl.confidence && <span className="ml-1 text-stone-400">({obl.confidence})</span>}</p>
                    </div>
                    {obl.gap_detail && (
                      <div className="col-span-2">
                        <p className="font-medium text-stone-500 mb-1">Gap Detail</p>
                        <p className="text-stone-700">{obl.gap_detail}</p>
                      </div>
                    )}
                    {obl.recommended_policy && (
                      <div>
                        <p className="font-medium text-stone-500 mb-1">Recommended Policy</p>
                        <p>{obl.recommended_policy}</p>
                      </div>
                    )}
                    {obl.policy_title && (
                      <div>
                        <p className="font-medium text-stone-500 mb-1">Covering Policy</p>
                        <p>{obl.policy_number} — {obl.policy_title}</p>
                      </div>
                    )}
                    {obl.human_status && (
                      <div className="col-span-2">
                        <p className="font-medium text-indigo-600 mb-1">Human Review</p>
                        <p><Badge status={obl.human_status} /> {obl.review_notes && <span className="ml-2 text-stone-600">{obl.review_notes}</span>}</p>
                        <p className="text-stone-400 mt-1">Reviewed {obl.reviewed_at ? new Date(obl.reviewed_at).toLocaleDateString() : ''}</p>
                      </div>
                    )}
                  </div>

                  {obl.assessment_id && !isReviewing && (
                    <button onClick={(e) => { e.stopPropagation(); setReviewingId(obl.id); }} className="mt-3 text-xs text-indigo-600 hover:text-indigo-800 font-medium">
                      {obl.human_status ? 'Update Review' : 'Add Human Review'}
                    </button>
                  )}
                  {isReviewing && <ReviewForm assessmentId={obl.assessment_id} currentStatus={obl.human_status || obl.status} currentNotes={obl.review_notes} onSubmit={handleReview} onCancel={() => setReviewingId(null)} />}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length > 200 && (
          <div className="px-4 py-3 text-xs text-stone-400 text-center">Showing first 200 of {filtered.length} results</div>
        )}
      </div>
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
