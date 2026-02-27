import { useState, useEffect, useCallback } from 'react';
import { Badge, FilterPill, StatCard, Spinner, EmptyState, exportCSV, STATES } from './shared';

export default function GapReportMode() {
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

