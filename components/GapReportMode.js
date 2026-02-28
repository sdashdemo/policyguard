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

  const bulkMarkNA = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Mark ${selected.size} items as NOT_APPLICABLE? This sets the human review status.`)) return;
    setBulkWorking(true);
    try {
      const res = await fetch('/api/v6/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assessment_ids: [...selected],
          human_status: 'NOT_APPLICABLE',
          review_notes: `Bulk marked N/A — ${tierFilter !== 'all' ? tierFilter + ' tier' : 'manual selection'}`,
          reviewed_by: 'clo',
        }),
      });
      if (res.ok) {
        fetchGaps();
      }
    } catch (err) {
      console.error('Bulk review error:', err);
    }
    setBulkWorking(false);
  };

  const bulkMarkStatus = async (status) => {
    if (selected.size === 0) return;
    if (!confirm(`Mark ${selected.size} items as ${status}?`)) return;
    setBulkWorking(true);
    try {
      const res = await fetch('/api/v6/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assessment_ids: [...selected],
          human_status: status,
          review_notes: `Bulk marked ${status}`,
          reviewed_by: 'clo',
        }),
      });
      if (res.ok) {
        fetchGaps();
      }
    } catch (err) {
      console.error('Bulk review error:', err);
    }
    setBulkWorking(false);
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

      {/* Tier summary bar */}
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
          <button onClick={() => bulkMarkNA()} disabled={bulkWorking} className="px-2 py-1 text-xs bg-stone-600 text-white rounded hover:bg-stone-700 disabled:opacity-50">
            {bulkWorking ? 'Working...' : 'Mark N/A'}
          </button>
          <button onClick={() => bulkMarkStatus('COVERED')} disabled={bulkWorking} className="px-2 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50">
            Mark Covered
          </button>
          <button onClick={() => bulkMarkStatus('GAP')} disabled={bulkWorking} className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
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
          {filtered.slice(0, 300).map((row, i) => (
            <div key={row.obligation_id || i} className={`px-4 py-2.5 row-hover flex items-start gap-0 ${selected.has(row.assessment_id) ? 'bg-indigo-50/50' : ''}`}>
              <span className="w-5 pt-1 flex-shrink-0">
                {row.assessment_id && (
                  <input type="checkbox" checked={selected.has(row.assessment_id)} onChange={() => toggleSelect(row.assessment_id)} className="rounded" />
                )}
              </span>
              <span className="w-16 pt-0.5 flex-shrink-0"><Badge status={row.human_status || row.status} /></span>
              <span className="w-24 pt-0.5 flex-shrink-0"><TierBadge tier={row.risk_tier} /></span>
              <span className="w-32 flex-shrink-0 text-xs font-mono text-stone-600 pt-0.5">{row.citation}</span>
              <span className="flex-1 min-w-0 text-sm text-stone-800 line-clamp-2 pr-2" title={row.gap_detail || ''}>{row.requirement}</span>
              <span className="w-20 flex-shrink-0 text-xs text-stone-500 text-right">{row.recommended_policy || row.policy_number || '—'}</span>
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
