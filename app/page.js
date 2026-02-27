'use client';
import { useState, useEffect, useCallback } from 'react';

// ─── CONSTANTS ──────────────────────────────────────────────

const MODES = [
  { id: 'pipeline', label: 'Pipeline', icon: '▶' },
  { id: 'dashboard', label: 'Dashboard', icon: '◫' },
  { id: 'facility', label: 'Facility View', icon: '⌂' },
  { id: 'regulations', label: 'Regulations', icon: '§' },
  { id: 'gaps', label: 'Gap Report', icon: '⚠' },
  { id: 'rewrite', label: 'Policy Rewrite', icon: '✎' },
  { id: 'actions', label: 'Action Items', icon: '☑' },
  { id: 'facilities', label: 'Facility Matrix', icon: '⊞' },
  { id: 'policies', label: 'Policies', icon: '◧' },
];

const STATUS_COLORS = {
  COVERED: { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-200', dot: 'bg-emerald-500' },
  PARTIAL: { bg: 'bg-amber-50', text: 'text-amber-700', ring: 'ring-amber-200', dot: 'bg-amber-500' },
  GAP: { bg: 'bg-red-50', text: 'text-red-700', ring: 'ring-red-200', dot: 'bg-red-500' },
  CONFLICTING: { bg: 'bg-purple-50', text: 'text-purple-700', ring: 'ring-purple-200', dot: 'bg-purple-500' },
  NEEDS_LEGAL_REVIEW: { bg: 'bg-indigo-50', text: 'text-indigo-700', ring: 'ring-indigo-200', dot: 'bg-indigo-500' },
  NOT_APPLICABLE: { bg: 'bg-stone-50', text: 'text-stone-500', ring: 'ring-stone-200', dot: 'bg-stone-400' },
  UNASSESSED: { bg: 'bg-stone-50', text: 'text-stone-400', ring: 'ring-stone-200', dot: 'bg-stone-300' },
};

const LOC_OPTIONS = [
  { id: 'detox', label: 'Detox' },
  { id: 'residential', label: 'Res' },
  { id: 'php', label: 'PHP' },
  { id: 'iop', label: 'IOP' },
  { id: 'op', label: 'OP' },
  { id: 'mh_rtf', label: 'MH RTF' },
  { id: 'mh_php', label: 'MH PHP' },
  { id: 'otp', label: 'OTP' },
];

const ACCREDITATION_OPTIONS = [
  { id: 'tjc', label: 'TJC' },
  { id: 'carf', label: 'CARF' },
];

const STATES = ['FL','GA','MD','NJ','OH','MO','IN','CO','WA','OR'];

// ─── SHARED COMPONENTS ──────────────────────────────────────

function Badge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.UNASSESSED;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.bg} ${c.text} ring-1 ${c.ring}`}>
      {status === 'NOT_APPLICABLE' ? 'N/A' : status || 'UNASSESSED'}
    </span>
  );
}

function CoverageBar({ covered = 0, partial = 0, gaps = 0, total = 0 }) {
  if (total === 0) return <div className="coverage-bar w-full"><div className="w-full bg-stone-200" /></div>;
  const pcts = { c: (covered / total) * 100, p: (partial / total) * 100, g: (gaps / total) * 100 };
  return (
    <div className="coverage-bar w-full">
      {pcts.c > 0 && <div className="seg-covered" style={{ width: `${pcts.c}%` }} />}
      {pcts.p > 0 && <div className="seg-partial" style={{ width: `${pcts.p}%` }} />}
      {pcts.g > 0 && <div className="seg-gap" style={{ width: `${pcts.g}%` }} />}
    </div>
  );
}

function StatCard({ label, value, sub, color = 'text-stone-900' }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-stone-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-xs text-stone-400 mt-1">{sub}</p>}
    </div>
  );
}

function EmptyState({ message }) {
  return <div className="text-center py-16 text-stone-400">{message}</div>;
}

function Spinner() {
  return <div className="flex items-center justify-center py-12"><div className="w-6 h-6 border-2 border-stone-300 border-t-stone-900 rounded-full animate-spin" /></div>;
}

function FilterPill({ active, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
        active ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
      }`}
    >
      {label}
    </button>
  );
}

// ─── DASHBOARD MODE ─────────────────────────────────────────

function DashboardMode({ data, onNavigate }) {
  if (!data) return <Spinner />;
  const s = data.stats;
  const totalAssessed = Number(s.total_assessed || 0);
  const totalObl = Number(s.total_obligations || 0);
  const covered = Number(s.covered || 0);
  const partial = Number(s.partial || 0);
  const gaps = Number(s.gaps || 0);
  const unassessed = totalObl - totalAssessed;

  return (
    <div className="page-enter space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Compliance Dashboard</h1>
        <p className="text-stone-500 text-sm mt-1">Advanced Recovery Systems — {data.facilities?.length || 0} facilities across {new Set(data.facilities?.map(f => f.state)).size} states</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Total Obligations" value={totalObl} />
        <StatCard label="Assessed" value={totalAssessed} sub={`${unassessed} remaining`} />
        <StatCard label="Covered" value={covered} color="text-emerald-700" />
        <StatCard label="Partial" value={partial} color="text-amber-700" />
        <StatCard label="Gaps" value={gaps} color="text-red-700" />
      </div>

      {totalAssessed > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Overall Coverage</span>
            <span className="text-xs text-stone-400">{totalAssessed} assessed of {totalObl}</span>
          </div>
          <CoverageBar covered={covered} partial={partial} gaps={gaps} total={totalAssessed} />
          <div className="flex gap-4 mt-2 text-xs text-stone-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Covered {totalAssessed > 0 ? Math.round(covered/totalAssessed*100) : 0}%</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Partial {totalAssessed > 0 ? Math.round(partial/totalAssessed*100) : 0}%</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Gap {totalAssessed > 0 ? Math.round(gaps/totalAssessed*100) : 0}%</span>
          </div>
        </div>
      )}

      {/* Regulatory Sources */}
      <div className="card">
        <div className="px-4 py-3 border-b border-stone-100">
          <h2 className="text-sm font-semibold">Regulatory Sources</h2>
        </div>
        <div className="divide-y divide-stone-100">
          {(data.sources || []).map(src => (
            <div key={src.source_id} className="px-4 py-3 row-hover flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{src.name}</p>
                <p className="text-xs text-stone-400">{src.state || 'Federal/All'} · {src.source_type}</p>
              </div>
              <div className="flex items-center gap-4 ml-4">
                <span className="text-xs text-stone-500 tabular-nums">{src.total_obligations} obligations</span>
                {Number(src.assessed) > 0 && (
                  <div className="w-24">
                    <CoverageBar covered={Number(src.covered)} partial={Number(src.partial)} gaps={Number(src.gaps)} total={Number(src.assessed)} />
                  </div>
                )}
                {Number(src.assessed) === 0 && <span className="text-xs text-stone-400">Not assessed</span>}
              </div>
            </div>
          ))}
          {(!data.sources || data.sources.length === 0) && <EmptyState message="No regulatory sources loaded" />}
        </div>
      </div>

      {/* Facilities */}
      <div className="card">
        <div className="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Facilities</h2>
          <button onClick={() => onNavigate('facilities')} className="text-xs text-stone-500 hover:text-stone-900 transition-colors">Edit Matrix →</button>
        </div>
        <div className="divide-y divide-stone-100">
          {(data.facilities || []).map(f => (
            <button
              key={f.facility_id}
              onClick={() => onNavigate('facility', f.facility_id)}
              className="w-full px-4 py-3 row-hover flex items-center justify-between text-left"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{f.name}</p>
                <p className="text-xs text-stone-400">
                  {f.state}
                  {f.levels_of_care?.length > 0 && ` · ${(f.levels_of_care || []).join(', ')}`}
                </p>
              </div>
              <div className="flex items-center gap-3 ml-4">
                {Number(f.total_assessed) > 0 ? (
                  <>
                    <div className="text-right">
                      <span className="text-xs tabular-nums">
                        <span className="text-emerald-600">{f.covered}</span>
                        {' / '}
                        <span className="text-amber-600">{f.partial}</span>
                        {' / '}
                        <span className="text-red-600">{f.gaps}</span>
                      </span>
                    </div>
                    <div className="w-20">
                      <CoverageBar covered={Number(f.covered)} partial={Number(f.partial)} gaps={Number(f.gaps)} total={Number(f.total_assessed)} />
                    </div>
                  </>
                ) : (
                  <span className="text-xs text-stone-400">No assessments</span>
                )}
                <span className="text-stone-300">›</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── FACILITY VIEW MODE ─────────────────────────────────────

function FacilityViewMode({ facilityId, onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [reviewingId, setReviewingId] = useState(null);

  useEffect(() => {
    if (!facilityId) return;
    setLoading(true);
    fetch(`/api/v6/facilities?id=${facilityId}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [facilityId]);

  const handleReview = async (assessmentId, humanStatus, notes) => {
    await fetch('/api/v6/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assessment_id: assessmentId, human_status: humanStatus, review_notes: notes }),
    });
    // Reload
    const d = await fetch(`/api/v6/facilities?id=${facilityId}`).then(r => r.json());
    setData(d);
    setReviewingId(null);
  };

  if (loading) return <Spinner />;
  if (!data?.facility) return <EmptyState message="Facility not found" />;

  const fac = data.facility;
  const obls = data.obligations || [];
  const sources = [...new Set(obls.map(o => o.source_name))].sort();

  // Filter
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
    unassessed: obls.filter(o => !o.status).length,
    reviewed: obls.filter(o => o.human_status).length,
  };

  return (
    <div className="page-enter space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => onNavigate('dashboard')} className="text-xs text-stone-400 hover:text-stone-700 mb-1">← Dashboard</button>
          <h1 className="text-xl font-semibold">{fac.name}</h1>
          <p className="text-sm text-stone-500">{fac.state} · {(fac.levels_of_care || []).join(', ') || 'No LOC configured'}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        <StatCard label="Total" value={counts.total} />
        <StatCard label="Covered" value={counts.covered} color="text-emerald-700" />
        <StatCard label="Partial" value={counts.partial} color="text-amber-700" />
        <StatCard label="Gaps" value={counts.gap} color="text-red-700" />
        <StatCard label="Unassessed" value={counts.unassessed} />
        <StatCard label="Human Reviewed" value={counts.reviewed} color="text-indigo-700" />
      </div>

      {counts.total > 0 && (
        <CoverageBar covered={counts.covered} partial={counts.partial} gaps={counts.gap} total={counts.total - counts.unassessed} />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {['all', 'GAP', 'PARTIAL', 'COVERED', 'UNASSESSED'].map(s => (
          <FilterPill key={s} active={filter === s} label={s === 'all' ? `All (${obls.length})` : `${s} (${s === 'UNASSESSED' ? counts.unassessed : counts[s.toLowerCase()] || 0})`} onClick={() => setFilter(s)} />
        ))}
        <span className="text-stone-300">|</span>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="text-xs border border-stone-200 rounded px-2 py-1 bg-white">
          <option value="all">All Sources</option>
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

                  {/* Human review controls */}
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

// ─── GAP REPORT MODE ────────────────────────────────────────

function GapReportMode() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('GAP');
  const [stateFilter, setStateFilter] = useState('all');
  const [search, setSearch] = useState('');

  const fetchGaps = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('status', filter);
    if (stateFilter !== 'all') params.set('state', stateFilter);
    fetch(`/api/v6/gaps?${params}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [filter, stateFilter]);

  useEffect(() => { fetchGaps(); }, [fetchGaps]);

  const filtered = (data?.rows || []).filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return r.citation?.toLowerCase().includes(q) || r.requirement?.toLowerCase().includes(q) || r.gap_detail?.toLowerCase().includes(q);
  });

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Gap Report</h1>
        <p className="text-sm text-stone-500">Filterable compliance gaps across all regulatory sources</p>
      </div>

      {data?.summary && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          <StatCard label="Total" value={data.summary.total} />
          <StatCard label="Covered" value={data.summary.covered} color="text-emerald-700" />
          <StatCard label="Partial" value={data.summary.partial} color="text-amber-700" />
          <StatCard label="Gaps" value={data.summary.gap} color="text-red-700" />
          <StatCard label="Unassessed" value={data.summary.unassessed} />
          <StatCard label="Reviewed" value={data.summary.human_reviewed} color="text-indigo-700" />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {['GAP', 'PARTIAL', 'COVERED', 'UNASSESSED', 'all'].map(s => (
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

      {loading ? <Spinner /> : (
        <div className="card divide-y divide-stone-100">
          <div className="px-4 py-2 bg-stone-50 rounded-t-lg border-b border-stone-200 flex items-center text-xs font-medium text-stone-500">
            <span className="w-10">Status</span>
            <span className="w-36 ml-2">Citation</span>
            <span className="flex-1 ml-2">Requirement</span>
            <span className="w-40 ml-2">Gap Detail</span>
            <span className="w-24 ml-2 text-right">Rec. Policy</span>
          </div>
          {filtered.length === 0 && <EmptyState message="No results match filters" />}
          {filtered.slice(0, 300).map((row, i) => (
            <div key={row.obligation_id || i} className="px-4 py-2.5 row-hover flex items-start gap-2">
              <span className="w-10 pt-0.5 flex-shrink-0"><Badge status={row.human_status || row.status} /></span>
              <span className="w-36 flex-shrink-0 text-xs font-mono text-stone-600 pt-0.5">{row.citation}</span>
              <span className="flex-1 text-sm text-stone-800 line-clamp-2">{row.requirement}</span>
              <span className="w-40 flex-shrink-0 text-xs text-stone-500 line-clamp-2">{row.gap_detail || '—'}</span>
              <span className="w-24 flex-shrink-0 text-xs text-stone-500 text-right">{row.recommended_policy || '—'}</span>
            </div>
          ))}
          {filtered.length > 300 && (
            <div className="px-4 py-3 text-xs text-stone-400 text-center">Showing first 300 of {filtered.length} results</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── FACILITY MATRIX MODE ───────────────────────────────────

function FacilityMatrixMode() {
  const [facilities, setFacilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    fetch('/api/v6/facilities')
      .then(r => r.json())
      .then(d => { setFacilities(d.facilities || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const toggleAttr = async (facilityId, field, value) => {
    const fac = facilities.find(f => f.facility_id === facilityId);
    if (!fac) return;
    const current = fac[field] || [];
    const updated = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    
    setSaving(facilityId);
    await fetch('/api/v6/facilities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: facilityId, [field]: updated }),
    });
    setFacilities(prev => prev.map(f =>
      f.facility_id === facilityId ? { ...f, [field]: updated } : f
    ));
    setSaving(null);
  };

  if (loading) return <Spinner />;

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Facility Matrix</h1>
        <p className="text-sm text-stone-500">Levels of care (editable) · License types (from master data) · Accreditations (editable)</p>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200">
              <th className="px-3 py-2 text-left font-semibold text-stone-600 sticky left-0 bg-stone-50 min-w-[200px]">Facility</th>
              <th className="px-2 py-2 text-center font-medium text-stone-500">State</th>
              {LOC_OPTIONS.map(loc => (
                <th key={loc.id} className="px-2 py-2 text-center font-medium text-stone-500 whitespace-nowrap">{loc.label}</th>
              ))}
              <th className="px-1 py-2 border-l border-stone-100" />
              {ACCREDITATION_OPTIONS.map(acc => (
                <th key={acc.id} className="px-2 py-2 text-center font-medium text-stone-500 whitespace-nowrap">{acc.label}</th>
              ))}
              <th className="px-1 py-2 border-l border-stone-100" />
              <th className="px-3 py-2 text-left font-medium text-stone-500 min-w-[250px]">License Types</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {facilities.map(fac => (
              <tr key={fac.facility_id} className={`row-hover ${saving === fac.facility_id ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 font-medium sticky left-0 bg-white">
                  {fac.name}
                  {fac.abbreviation && <span className="text-stone-400 ml-1">({fac.abbreviation})</span>}
                </td>
                <td className="px-2 py-2 text-center text-stone-500">{fac.state}</td>
                {LOC_OPTIONS.map(loc => (
                  <td key={loc.id} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={(fac.levels_of_care || []).includes(loc.id)}
                      onChange={() => toggleAttr(fac.facility_id, 'levels_of_care', loc.id)}
                      className="rounded"
                    />
                  </td>
                ))}
                <td className="px-1 py-2 border-l border-stone-100" />
                {ACCREDITATION_OPTIONS.map(acc => (
                  <td key={acc.id} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={(fac.accreditations || []).includes(acc.id)}
                      onChange={() => toggleAttr(fac.facility_id, 'accreditations', acc.id)}
                      className="rounded"
                    />
                  </td>
                ))}
                <td className="px-1 py-2 border-l border-stone-100" />
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(fac.license_types || []).map(lt => (
                      <span key={lt} className="inline-block px-1.5 py-0.5 bg-stone-100 text-stone-600 rounded text-[10px]">
                        {lt.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── REGULATIONS MODE ───────────────────────────────────────

function RegulationsMode({ onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/v6/dashboard')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;

  const sources = data?.sources || [];

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Regulatory Sources</h1>
        <p className="text-sm text-stone-500">{sources.length} sources loaded · {sources.reduce((a, s) => a + Number(s.total_obligations || 0), 0)} total obligations</p>
      </div>

      <div className="card divide-y divide-stone-100">
        {sources.map(src => {
          const total = Number(src.total_obligations || 0);
          const assessed = Number(src.assessed || 0);
          const pctAssessed = total > 0 ? Math.round(assessed / total * 100) : 0;

          return (
            <div key={src.source_id} className="px-4 py-4 row-hover">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold">{src.name}</p>
                  <p className="text-xs text-stone-400 mt-0.5">
                    {src.state || 'Federal/All'} · {src.source_type} · {total} obligations
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs tabular-nums">
                    {assessed > 0 ? (
                      <>
                        <span className="text-emerald-600">{src.covered} covered</span>
                        {' · '}
                        <span className="text-amber-600">{src.partial} partial</span>
                        {' · '}
                        <span className="text-red-600">{src.gaps} gaps</span>
                      </>
                    ) : (
                      <span className="text-stone-400">Not assessed</span>
                    )}
                  </p>
                  <p className="text-xs text-stone-400 mt-0.5">{pctAssessed}% assessed</p>
                </div>
              </div>
              {assessed > 0 && (
                <div className="mt-2">
                  <CoverageBar covered={Number(src.covered)} partial={Number(src.partial)} gaps={Number(src.gaps)} total={assessed} />
                </div>
              )}
            </div>
          );
        })}
        {sources.length === 0 && <EmptyState message="No regulatory sources loaded yet" />}
      </div>
    </div>
  );
}

// ─── POLICIES MODE ──────────────────────────────────────────

function PoliciesMode() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('all');

  useEffect(() => {
    fetch('/api/v6/gaps?status=all')
      .then(r => r.json())
      .then(d => {
        // Extract unique policies from gap data
        const policyMap = {};
        for (const row of (d.rows || [])) {
          if (row.policy_number && !policyMap[row.policy_number]) {
            policyMap[row.policy_number] = {
              policy_number: row.policy_number,
              title: row.policy_title,
              domain: row.policy_domain,
              obligations_covered: 0,
            };
          }
          if (row.policy_number && (row.status === 'COVERED' || row.status === 'PARTIAL')) {
            policyMap[row.policy_number].obligations_covered++;
          }
        }
        setPolicies(Object.values(policyMap).sort((a, b) => (a.policy_number || '').localeCompare(b.policy_number || '')));
        setLoading(false);
      })
      .catch(() => {
        // Fallback: load from DB directly
        fetch('/api/db?keys=index')
          .then(r => r.json())
          .then(d => {
            const idx = d.index || [];
            setPolicies(idx.map(p => ({ policy_number: p.policy_id, title: p.title, domain: p.domain, obligations_covered: 0 })));
            setLoading(false);
          })
          .catch(() => setLoading(false));
      });
  }, []);

  const domains = [...new Set(policies.map(p => p.domain).filter(Boolean))].sort();
  let filtered = policies;
  if (domainFilter !== 'all') filtered = filtered.filter(p => p.domain === domainFilter);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(p => p.policy_number?.toLowerCase().includes(q) || p.title?.toLowerCase().includes(q));
  }

  if (loading) return <Spinner />;

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Policy Registry</h1>
        <p className="text-sm text-stone-500">{policies.length} policies indexed</p>
      </div>

      <div className="flex items-center gap-2">
        <select value={domainFilter} onChange={e => setDomainFilter(e.target.value)} className="text-xs border border-stone-200 rounded px-2 py-1 bg-white">
          <option value="all">All Domains</option>
          {domains.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search policies..."
          className="text-xs border border-stone-200 rounded px-2 py-1 bg-white flex-1 min-w-[200px]"
        />
      </div>

      <div className="card divide-y divide-stone-100">
        <div className="px-4 py-2 bg-stone-50 rounded-t-lg border-b border-stone-200 flex items-center text-xs font-medium text-stone-500">
          <span className="w-28">Policy #</span>
          <span className="flex-1 ml-2">Title</span>
          <span className="w-32 ml-2">Domain</span>
          <span className="w-24 ml-2 text-right">Linked Obls</span>
        </div>
        {filtered.map((p, i) => (
          <div key={p.policy_number || i} className="px-4 py-2.5 row-hover flex items-center gap-2">
            <span className="w-28 flex-shrink-0 text-xs font-mono text-stone-600">{p.policy_number}</span>
            <span className="flex-1 text-sm">{p.title}</span>
            <span className="w-32 flex-shrink-0 text-xs text-stone-500">{p.domain || '—'}</span>
            <span className="w-24 flex-shrink-0 text-xs text-stone-500 text-right tabular-nums">{p.obligations_covered || 0}</span>
          </div>
        ))}
        {filtered.length === 0 && <EmptyState message="No policies found" />}
      </div>
    </div>
  );
}

// ─── POLICY REWRITE MODE ────────────────────────────────────

function PolicyRewriteMode() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPolicy, setSelectedPolicy] = useState(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteResult, setRewriteResult] = useState(null);

  useEffect(() => {
    // Load policies that have gaps/partials linked to them
    fetch('/api/v6/gaps?status=all')
      .then(r => r.json())
      .then(d => {
        const policyGaps = {};
        for (const row of (d.rows || [])) {
          const pnum = row.recommended_policy || row.policy_number;
          if (!pnum) continue;
          if (!policyGaps[pnum]) policyGaps[pnum] = { policy_number: pnum, title: row.policy_title || pnum, gaps: 0, partials: 0, obligations: [] };
          if (row.status === 'GAP') policyGaps[pnum].gaps++;
          if (row.status === 'PARTIAL') policyGaps[pnum].partials++;
          if (row.status === 'GAP' || row.status === 'PARTIAL') {
            policyGaps[pnum].obligations.push({ citation: row.citation, requirement: row.requirement, status: row.status, gap_detail: row.gap_detail });
          }
        }
        const sorted = Object.values(policyGaps).filter(p => p.gaps + p.partials > 0).sort((a, b) => (b.gaps + b.partials) - (a.gaps + a.partials));
        setPolicies(sorted);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleRewrite = async (policyNumber) => {
    setRewriting(true);
    setRewriteResult(null);
    try {
      const res = await fetch('/api/rewrite-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy_number: policyNumber }),
      });
      if (res.ok) {
        const data = await res.json();
        setRewriteResult(data);
      } else {
        setRewriteResult({ error: 'Rewrite failed' });
      }
    } catch (err) {
      setRewriteResult({ error: err.message });
    }
    setRewriting(false);
  };

  if (loading) return <Spinner />;

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Policy Rewrite</h1>
        <p className="text-sm text-stone-500">Policies ranked by number of unresolved gaps and partials — select one to generate AI-drafted revisions</p>
      </div>

      {!selectedPolicy ? (
        <div className="card divide-y divide-stone-100">
          <div className="px-4 py-2 bg-stone-50 rounded-t-lg border-b border-stone-200 flex items-center text-xs font-medium text-stone-500">
            <span className="w-28">Policy #</span>
            <span className="flex-1 ml-2">Title</span>
            <span className="w-16 text-center ml-2">Gaps</span>
            <span className="w-16 text-center ml-2">Partials</span>
            <span className="w-20 text-right ml-2">Action</span>
          </div>
          {policies.length === 0 && <EmptyState message="No policies with gaps found — run assessments first" />}
          {policies.map((p, i) => (
            <div key={p.policy_number || i} className="px-4 py-2.5 row-hover flex items-center gap-2">
              <span className="w-28 flex-shrink-0 text-xs font-mono text-stone-600">{p.policy_number}</span>
              <span className="flex-1 text-sm truncate">{p.title}</span>
              <span className="w-16 text-center text-xs"><span className="badge-gap badge">{p.gaps}</span></span>
              <span className="w-16 text-center text-xs"><span className="badge-partial badge">{p.partials}</span></span>
              <span className="w-20 text-right">
                <button onClick={() => setSelectedPolicy(p)} className="text-xs px-2 py-1 bg-stone-900 text-white rounded hover:bg-stone-800">Select</button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={() => { setSelectedPolicy(null); setRewriteResult(null); }} className="text-xs text-stone-400 hover:text-stone-700">← Back to policy list</button>
          
          <div className="card p-4">
            <h2 className="font-semibold">{selectedPolicy.policy_number} — {selectedPolicy.title}</h2>
            <p className="text-sm text-stone-500 mt-1">{selectedPolicy.gaps} gaps · {selectedPolicy.partials} partials</p>
            
            <div className="mt-3 space-y-2">
              <p className="text-xs font-medium text-stone-500">Unresolved obligations:</p>
              {selectedPolicy.obligations.slice(0, 20).map((obl, i) => (
                <div key={i} className="text-xs p-2 bg-stone-50 rounded">
                  <div className="flex items-start gap-2">
                    <Badge status={obl.status} />
                    <span className="font-mono text-stone-500">{obl.citation}</span>
                  </div>
                  <p className="mt-1 text-stone-700">{obl.requirement}</p>
                  {obl.gap_detail && <p className="mt-1 text-red-600">{obl.gap_detail}</p>}
                </div>
              ))}
              {selectedPolicy.obligations.length > 20 && <p className="text-xs text-stone-400">+ {selectedPolicy.obligations.length - 20} more</p>}
            </div>

            <div className="mt-4">
              <button
                onClick={() => handleRewrite(selectedPolicy.policy_number)}
                disabled={rewriting}
                className="px-4 py-2 bg-stone-900 text-white text-sm font-medium rounded hover:bg-stone-800 disabled:opacity-50"
              >
                {rewriting ? 'Generating Rewrite...' : 'Generate AI Rewrite'}
              </button>
            </div>
          </div>

          {rewriteResult && !rewriteResult.error && (
            <div className="card p-4">
              <h3 className="font-semibold text-sm mb-2">Rewritten Policy</h3>
              <pre className="text-xs whitespace-pre-wrap bg-stone-50 p-4 rounded max-h-[600px] overflow-y-auto font-mono leading-relaxed">{rewriteResult.rewrite || rewriteResult.output || JSON.stringify(rewriteResult, null, 2)}</pre>
            </div>
          )}
          {rewriteResult?.error && (
            <div className="card p-4 bg-red-50 border-red-200">
              <p className="text-sm text-red-700">Error: {rewriteResult.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ACTIONS MODE ───────────────────────────────────────────

function ActionsMode() {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('open');

  useEffect(() => {
    fetch(`/api/v6/actions?status=${statusFilter}`)
      .then(r => r.json())
      .then(d => { setActions(d.actions || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [statusFilter]);

  if (loading) return <Spinner />;

  const counts = {
    open: actions.filter(a => a.status === 'open').length,
    in_progress: actions.filter(a => a.status === 'in_progress').length,
    completed: actions.filter(a => a.status === 'completed').length,
  };

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Action Items</h1>
        <p className="text-sm text-stone-500">Remediation tasks generated from gap analysis</p>
      </div>

      <div className="flex items-center gap-2">
        {['open', 'in_progress', 'completed', 'all'].map(s => (
          <FilterPill key={s} active={statusFilter === s} label={`${s.replace('_', ' ')} ${s !== 'all' ? `(${counts[s] || 0})` : ''}`} onClick={() => setStatusFilter(s)} />
        ))}
      </div>

      <div className="card divide-y divide-stone-100">
        {actions.length === 0 && <EmptyState message="No action items yet — they'll be created from gap assessments" />}
        {actions.map(a => (
          <div key={a.id} className="px-4 py-3 row-hover">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{a.title}</p>
                <p className="text-xs text-stone-400">{a.type} · {a.priority} priority{a.owner ? ` · ${a.owner}` : ''}{a.due_date ? ` · due ${a.due_date}` : ''}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded ${a.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : a.status === 'in_progress' ? 'bg-blue-50 text-blue-700' : 'bg-stone-100 text-stone-600'}`}>
                {a.status}
              </span>
            </div>
            {a.description && <p className="text-xs text-stone-600 mt-1">{a.description}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── PIPELINE MODE ──────────────────────────────────────────

const REG_SOURCE_PRESETS = [
  { name: '65D-30 (DCF SUD)', state: 'FL', source_type: 'state_reg', citation_root: '65D-30' },
  { name: '65E-4 (AHCA MH RTF)', state: 'FL', source_type: 'state_reg', citation_root: '65E-4' },
  { name: 'Ch. 397 (Marchman Act)', state: 'FL', source_type: 'state_reg', citation_root: 'Ch. 397' },
  { name: 'TJC BHC Standards', state: null, source_type: 'tjc', citation_root: 'TJC' },
  { name: '42 CFR Part 8 (OTP)', state: null, source_type: 'federal', citation_root: '42 CFR 8' },
  { name: 'Other', state: null, source_type: 'state_reg', citation_root: '' },
];

function PipelineMode() {
  const [steps, setSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [running, setRunning] = useState(null);
  const [runLog, setRunLog] = useState([]);
  const [regPreset, setRegPreset] = useState(REG_SOURCE_PRESETS[0]);

  const refreshPipeline = () => {
    fetch('/api/v6/pipeline')
      .then(r => r.json())
      .then(d => { setSteps(d.steps || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { refreshPipeline(); }, []);

  const addLog = (msg) => setRunLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  // ── Upload a single regulatory source ──
  const handleRegUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    addLog(`Uploading regulatory source: ${file.name}`);

    const form = new FormData();
    form.append('file', file);
    form.append('type', 'reg_source');
    form.append('source_name', regPreset.name);
    form.append('state', regPreset.state || '');
    form.append('source_type', regPreset.source_type);
    form.append('citation_root', regPreset.citation_root);

    try {
      const res = await fetch('/api/v6/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (data.ok) {
        addLog(`✓ Uploaded ${file.name} — ${data.text_length.toLocaleString()} chars extracted`);
      } else {
        addLog(`✗ Error: ${data.error}`);
      }
    } catch (err) {
      addLog(`✗ Upload failed: ${err.message}`);
    }
    e.target.value = '';
    setUploading(false);
    refreshPipeline();
  };

  // ── Batch upload policies ──
  const handlePolicyUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    addLog(`Uploading ${files.length} policy files...`);

    // Upload in batches of 10
    let uploaded = 0;
    let errors = 0;
    for (let i = 0; i < files.length; i += 10) {
      const batch = files.slice(i, i + 10);
      const form = new FormData();
      batch.forEach(f => form.append('files', f));

      try {
        const res = await fetch('/api/v6/upload', { method: 'PUT', body: form });
        const data = await res.json();
        uploaded += data.uploaded || 0;
        errors += data.errors || 0;
        setUploadProgress(`${uploaded}/${files.length} uploaded`);
        if (data.errors_detail?.length) {
          data.errors_detail.forEach(e => addLog(`  ✗ ${e.filename}: ${e.error}`));
        }
      } catch (err) {
        addLog(`  ✗ Batch error: ${err.message}`);
        errors += batch.length;
      }
    }

    addLog(`✓ Policy upload complete: ${uploaded} uploaded, ${errors} errors`);
    e.target.value = '';
    setUploading(false);
    setUploadProgress(null);
    refreshPipeline();
  };

  // ── Run pipeline step ──
  const runStep = async (stepId) => {
    setRunning(stepId);

    if (stepId === 'extract_obligations') {
      addLog('Starting obligation extraction from regulatory sources...');
      try {
        const res = await fetch('/api/extract-requirements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'all' }),
        });
        const data = await res.json();
        addLog(`✓ Extracted ${data.total_requirements || data.total || '?'} obligations`);
      } catch (err) {
        addLog(`✗ Extraction error: ${err.message}`);
      }
    }

    if (stepId === 'index_policies') {
      addLog('Starting policy indexing (this takes a while for 370+ policies)...');
      try {
        const res = await fetch('/api/index-policy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'unindexed' }),
        });
        const data = await res.json();
        addLog(`✓ Indexed ${data.indexed || data.total || '?'} policies`);
      } catch (err) {
        addLog(`✗ Indexing error: ${err.message}`);
      }
    }

    if (stepId === 'embed') {
      addLog('Generating embeddings (Voyage AI)...');
      let remaining = 999;
      let rounds = 0;
      while (remaining > 0 && rounds < 50) {
        try {
          const res = await fetch('/api/v6/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'all' }),
          });
          const data = await res.json();
          remaining = Number(data.remaining?.obls_remaining || 0) + Number(data.remaining?.provs_remaining || 0);
          addLog(`  Embedded batch — ${remaining} remaining`);
          rounds++;
        } catch (err) {
          addLog(`✗ Embedding error: ${err.message}`);
          break;
        }
      }
      addLog(`✓ Embedding complete after ${rounds} batches`);
    }

    if (stepId === 'assess') {
      addLog('Running coverage assessments (Claude + hybrid matching)...');
      try {
        const res = await fetch('/api/map-coverage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'unassessed', state: 'FL' }),
        });
        const data = await res.json();
        addLog(`✓ Assessment complete: ${data.total || '?'} obligations assessed`);
      } catch (err) {
        addLog(`✗ Assessment error: ${err.message}`);
      }
    }

    setRunning(null);
    refreshPipeline();
  };

  if (loading) return <Spinner />;

  const stepColors = {
    done: 'bg-emerald-500',
    ready: 'bg-amber-400',
    blocked: 'bg-stone-300',
    pending: 'bg-stone-300',
  };

  return (
    <div className="page-enter space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Pipeline</h1>
        <p className="text-sm text-stone-500">Upload documents and run the assessment pipeline step by step</p>
      </div>

      {/* Pipeline status */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Pipeline Status</p>
        {steps.map(step => (
          <div key={step.id} className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${stepColors[step.status]}`} />
            <div className="flex-1">
              <p className="text-sm font-medium">{step.label}</p>
              <p className="text-xs text-stone-400">{step.detail}</p>
            </div>
            {(step.status === 'ready' || step.status === 'done') && step.id !== 'upload_regs' && step.id !== 'upload_policies' && (
              <button
                onClick={() => runStep(step.id)}
                disabled={running !== null}
                className="text-xs px-3 py-1 bg-stone-900 text-white rounded hover:bg-stone-800 disabled:opacity-50"
              >
                {running === step.id ? 'Running...' : step.status === 'done' ? 'Re-run' : 'Run'}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Upload: Regulatory Sources */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Upload Regulatory Source</p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <label className="text-xs text-stone-500 block mb-1">Source type</label>
            <select
              value={regPreset.name}
              onChange={(e) => setRegPreset(REG_SOURCE_PRESETS.find(p => p.name === e.target.value) || REG_SOURCE_PRESETS[0])}
              className="w-full text-sm border border-stone-200 rounded px-2 py-1.5 bg-white"
            >
              {REG_SOURCE_PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs px-3 py-1.5 bg-stone-900 text-white rounded hover:bg-stone-800 cursor-pointer inline-block">
              {uploading ? 'Uploading...' : 'Choose File'}
              <input type="file" accept=".docx,.doc,.pdf,.txt" onChange={handleRegUpload} disabled={uploading} className="hidden" />
            </label>
          </div>
        </div>
        <p className="text-xs text-stone-400">Accepts .docx, .pdf, or .txt — one regulatory source at a time</p>
      </div>

      {/* Upload: Policies */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Upload Policy Documents</p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <p className="text-sm">Select all policy Word docs at once — they'll be uploaded in batches of 10</p>
            {uploadProgress && <p className="text-xs text-amber-600 mt-1">{uploadProgress}</p>}
          </div>
          <div>
            <label className="text-xs px-3 py-1.5 bg-stone-900 text-white rounded hover:bg-stone-800 cursor-pointer inline-block">
              {uploading ? 'Uploading...' : 'Choose Files'}
              <input type="file" accept=".docx,.doc,.pdf,.txt" multiple onChange={handlePolicyUpload} disabled={uploading} className="hidden" />
            </label>
          </div>
        </div>
        <p className="text-xs text-stone-400">Select multiple files (Ctrl/Cmd+A in file picker). Accepts .docx, .pdf, or .txt</p>
      </div>

      {/* Run log */}
      {runLog.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Activity Log</p>
            <button onClick={() => setRunLog([])} className="text-xs text-stone-400 hover:text-stone-600">Clear</button>
          </div>
          <div className="bg-stone-950 text-stone-300 rounded p-3 max-h-[300px] overflow-y-auto font-mono text-xs space-y-0.5">
            {runLog.map((line, i) => (
              <div key={i} className={line.includes('✗') ? 'text-red-400' : line.includes('✓') ? 'text-emerald-400' : ''}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CSV EXPORT ─────────────────────────────────────────────

function exportCSV(rows) {
  const headers = ['citation', 'requirement', 'status', 'confidence', 'gap_detail', 'recommended_policy', 'policy_number', 'source_name', 'source_state'];
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `policyguard-gaps-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─── MAIN APP ───────────────────────────────────────────────

export default function PolicyGuard() {
  const [mode, setMode] = useState('dashboard');
  const [selectedFacility, setSelectedFacility] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);

  useEffect(() => {
    fetch('/api/v6/dashboard')
      .then(r => r.json())
      .then(d => setDashboardData(d))
      .catch(err => console.error('Dashboard load:', err));
  }, []);

  const navigate = (newMode, facilityId) => {
    if (newMode === 'facility' && facilityId) {
      setSelectedFacility(facilityId);
      setMode('facility');
    } else {
      setMode(newMode);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <nav className="w-56 bg-stone-900 text-stone-300 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-stone-800">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 bg-white text-stone-900 rounded flex items-center justify-center text-xs font-bold">PG</span>
            <div>
              <p className="text-sm font-semibold text-white">PolicyGuard</p>
              <p className="text-[10px] text-stone-500">v6 · ARS Compliance</p>
            </div>
          </div>
        </div>
        <div className="flex-1 p-2 space-y-0.5">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => navigate(m.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                mode === m.id ? 'bg-stone-800 text-white' : 'hover:bg-stone-800/50 hover:text-stone-200'
              }`}
            >
              <span className="w-5 text-center opacity-60">{m.icon}</span>
              {m.label}
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-stone-800">
          <p className="text-[10px] text-stone-600">Advanced Recovery Systems</p>
          <p className="text-[10px] text-stone-600">CLO Dashboard</p>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-6">
          {mode === 'pipeline' && <PipelineMode />}
          {mode === 'dashboard' && <DashboardMode data={dashboardData} onNavigate={navigate} />}
          {mode === 'facility' && <FacilityViewMode facilityId={selectedFacility} onNavigate={navigate} />}
          {mode === 'regulations' && <RegulationsMode onNavigate={navigate} />}
          {mode === 'gaps' && <GapReportMode />}
          {mode === 'rewrite' && <PolicyRewriteMode />}
          {mode === 'actions' && <ActionsMode />}
          {mode === 'facilities' && <FacilityMatrixMode />}
          {mode === 'policies' && <PoliciesMode />}
        </div>
      </main>
    </div>
  );
}
