import { useState, useEffect } from 'react';
import { Badge, CoverageBar, StatCard, FilterPill, Spinner, EmptyState } from './shared';

export default function RegulationsMode({ onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expandedSource, setExpandedSource] = useState(null);
  const [sourceObligations, setSourceObligations] = useState({});
  const [sourceLoading, setSourceLoading] = useState(null);
  const [oblFilter, setOblFilter] = useState('all');
  const [oblSearch, setOblSearch] = useState('');

  useEffect(() => {
    fetch('/api/v6/dashboard')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const loadSourceObligations = (sourceId) => {
    if (sourceObligations[sourceId]) return; // already loaded
    setSourceLoading(sourceId);
    fetch(`/api/v6/gaps?source_id=${sourceId}&status=all`)
      .then(r => r.json())
      .then(d => {
        setSourceObligations(prev => ({ ...prev, [sourceId]: d.rows || [] }));
        setSourceLoading(null);
      })
      .catch(() => setSourceLoading(null));
  };

  const toggleSource = (sourceId) => {
    if (expandedSource === sourceId) {
      setExpandedSource(null);
      setOblFilter('all');
      setOblSearch('');
    } else {
      setExpandedSource(sourceId);
      setOblFilter('all');
      setOblSearch('');
      loadSourceObligations(sourceId);
    }
  };

  if (loading) return <Spinner />;

  const sources = data?.sources || [];
  const stats = data?.stats || {};

  // Aggregate stats
  const totalObligations = sources.reduce((a, s) => a + Number(s.total_obligations || 0), 0);
  const totalCovered = sources.reduce((a, s) => a + Number(s.covered || 0), 0);
  const totalPartial = sources.reduce((a, s) => a + Number(s.partial || 0), 0);
  const totalGaps = sources.reduce((a, s) => a + Number(s.gaps || 0), 0);
  const totalAssessed = totalCovered + totalPartial + totalGaps;

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Regulatory Sources</h1>
        <p className="text-sm text-stone-500">
          {sources.length} sources · {totalObligations} total obligations · {totalAssessed} assessed
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <StatCard label="Sources" value={sources.length} />
        <StatCard label="Obligations" value={totalObligations} />
        <StatCard label="Covered" value={totalCovered} color="text-emerald-700" />
        <StatCard label="Partial" value={totalPartial} color="text-amber-700" />
        <StatCard label="Gaps" value={totalGaps} color="text-red-700" />
      </div>

      {totalAssessed > 0 && (
        <CoverageBar covered={totalCovered} partial={totalPartial} gaps={totalGaps} total={totalAssessed} />
      )}

      <div className="card divide-y divide-stone-100">
        {sources.map(src => {
          const total = Number(src.total_obligations || 0);
          const covered = Number(src.covered || 0);
          const partial = Number(src.partial || 0);
          const gaps = Number(src.gaps || 0);
          const assessed = covered + partial + gaps;
          const isExpanded = expandedSource === src.source_id;
          const obls = sourceObligations[src.source_id] || [];
          const isOblLoading = sourceLoading === src.source_id;

          // Filter obligations within expanded source
          let filteredObls = obls;
          if (oblFilter !== 'all') {
            if (oblFilter === 'UNASSESSED') filteredObls = filteredObls.filter(o => !o.status);
            else filteredObls = filteredObls.filter(o => o.status === oblFilter);
          }
          if (oblSearch) {
            const q = oblSearch.toLowerCase();
            filteredObls = filteredObls.filter(o =>
              o.citation?.toLowerCase().includes(q) || o.requirement?.toLowerCase().includes(q)
            );
          }

          return (
            <div key={src.source_id}>
              <button
                onClick={() => toggleSource(src.source_id)}
                className="w-full px-4 py-4 row-hover text-left"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                    <div>
                      <p className="text-sm font-semibold">{src.name}</p>
                      <p className="text-xs text-stone-400 mt-0.5">
                        {src.state || 'Federal/All'} · {src.source_type} · {total} obligations
                      </p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {assessed > 0 ? (
                      <>
                        <p className="text-xs tabular-nums">
                          <span className="text-emerald-600">{covered} covered</span>
                          {' · '}
                          <span className="text-amber-600">{partial} partial</span>
                          {' · '}
                          <span className="text-red-700 font-semibold">{gaps} gaps</span>
                        </p>
                        <p className="text-xs text-stone-400 mt-0.5">{Math.round(assessed / total * 100)}% assessed</p>
                      </>
                    ) : (
                      <p className="text-xs text-stone-400">Not assessed</p>
                    )}
                  </div>
                </div>
                {assessed > 0 && (
                  <div className="mt-2 ml-7">
                    <CoverageBar covered={covered} partial={partial} gaps={gaps} total={assessed} />
                  </div>
                )}
              </button>

              {/* Expanded: obligation drill-down */}
              {isExpanded && (
                <div className="bg-stone-50 border-t border-stone-200 px-4 py-4">
                  {isOblLoading ? (
                    <Spinner />
                  ) : (
                    <>
                      {/* Filters */}
                      <div className="flex flex-wrap items-center gap-2 mb-3 ml-7">
                        {['all', 'GAP', 'PARTIAL', 'COVERED', 'CONFLICTING', 'UNASSESSED'].map(s => {
                          const count = s === 'all' ? obls.length
                            : s === 'UNASSESSED' ? obls.filter(o => !o.status).length
                            : obls.filter(o => o.status === s).length;
                          if (count === 0 && s !== 'all') return null;
                          return (
                            <FilterPill key={s} active={oblFilter === s} label={`${s === 'all' ? 'All' : s} (${count})`} onClick={() => setOblFilter(s)} />
                          );
                        })}
                        <input
                          type="text" value={oblSearch} onChange={e => setOblSearch(e.target.value)}
                          placeholder="Search obligations..."
                          className="text-xs border border-stone-200 rounded px-2 py-1 bg-white flex-1 min-w-[180px]"
                        />
                      </div>

                      {/* Obligation rows */}
                      <div className="ml-7 border border-stone-200 rounded-lg bg-white divide-y divide-stone-100">
                        <div className="px-3 py-1.5 bg-stone-50 rounded-t-lg flex items-center text-[11px] font-medium text-stone-400">
                          <span className="w-14">Status</span>
                          <span className="w-44">Citation</span>
                          <span className="flex-1">Requirement</span>
                          <span className="w-20 text-right">Policy</span>
                        </div>
                        {filteredObls.length === 0 && (
                          <div className="px-3 py-6 text-center text-xs text-stone-400">No obligations match filters</div>
                        )}
                        {filteredObls.slice(0, 100).map((obl, i) => {
                          const effectiveStatus = obl.human_status || obl.status;
                          return (
                            <div key={obl.obligation_id || i} className="px-3 py-2 flex items-start gap-1 text-xs hover:bg-stone-50 group">
                              <span className="w-14 pt-0.5 flex-shrink-0">
                                <Badge status={effectiveStatus} />
                              </span>
                              <span className="w-44 flex-shrink-0 font-mono text-stone-600 pt-0.5">{obl.citation}</span>
                              <span className="flex-1 min-w-0 text-stone-700 line-clamp-2" title={obl.gap_detail || obl.requirement}>
                                {obl.requirement}
                              </span>
                              <span className="w-20 flex-shrink-0 text-stone-400 text-right pt-0.5">
                                {obl.policy_number || '—'}
                              </span>
                            </div>
                          );
                        })}
                        {filteredObls.length > 100 && (
                          <div className="px-3 py-2 text-center text-[11px] text-stone-400">
                            Showing 100 of {filteredObls.length} · Use Gap Report for full view
                          </div>
                        )}
                      </div>
                    </>
                  )}
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
