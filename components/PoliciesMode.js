import { useState, useEffect } from 'react';
import { Badge, CoverageBar, Spinner, EmptyState } from './shared';

// Natural sort: "CL-1.001" before "CL-10.001"
function naturalSort(a, b) {
  const pa = (a.policy_number || '').split(/(\d+)/);
  const pb = (b.policy_number || '').split(/(\d+)/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ca = pa[i] || '', cb = pb[i] || '';
    const na = parseInt(ca, 10), nb = parseInt(cb, 10);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const cmp = ca.localeCompare(cb);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

export default function PoliciesMode() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('all');
  const [domains, setDomains] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetch('/api/v6/policies')
      .then(r => r.json())
      .then(d => {
        const sorted = (d.policies || []).sort(naturalSort);
        setPolicies(sorted);
        setDomains(d.domains || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const toggleExpand = (policyId) => {
    if (expandedId === policyId) {
      setExpandedId(null);
      setDetail(null);
    } else {
      setExpandedId(policyId);
      setDetail(null);
      setDetailLoading(true);
      fetch(`/api/v6/policies?id=${policyId}`)
        .then(r => r.json())
        .then(d => { setDetail(d); setDetailLoading(false); })
        .catch(() => setDetailLoading(false));
    }
  };

  let filtered = policies;
  if (domainFilter !== 'all') filtered = filtered.filter(p => p.domain === domainFilter);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(p =>
      p.policy_number?.toLowerCase().includes(q) ||
      p.title?.toLowerCase().includes(q) ||
      p.summary?.toLowerCase().includes(q)
    );
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
          <option value="all">All Domains ({policies.length})</option>
          {domains.map(d => <option key={d} value={d}>{d} ({policies.filter(p => p.domain === d).length})</option>)}
        </select>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search policies..."
          className="text-xs border border-stone-200 rounded px-2 py-1 bg-white flex-1 min-w-[200px]"
        />
        <span className="text-xs text-stone-400">{filtered.length} shown</span>
      </div>

      <div className="card divide-y divide-stone-100">
        <div className="px-4 py-2 bg-stone-50 rounded-t-lg border-b border-stone-200 flex items-center text-xs font-medium text-stone-500">
          <span className="w-28">Policy #</span>
          <span className="flex-1 ml-2">Title</span>
          <span className="w-28 ml-2">Domain</span>
          <span className="w-16 ml-2 text-right">Provs</span>
          <span className="w-20 ml-2 text-right">Linked</span>
          <span className="w-28 ml-2 text-right">Coverage</span>
        </div>
        {filtered.length === 0 && <EmptyState message="No policies found" />}
        {filtered.map((p) => {
          const isExpanded = expandedId === p.id;
          const covered = Number(p.covered_count || 0);
          const partial = Number(p.partial_count || 0);
          const gap = Number(p.gap_count || 0);
          const conflicting = Number(p.conflicting_count || 0);
          const totalLinked = Number(p.assessment_count || 0);

          return (
            <div key={p.id}>
              <button
                onClick={() => toggleExpand(p.id)}
                className="w-full px-4 py-2.5 row-hover flex items-center gap-2 text-left"
              >
                <span className="w-28 flex-shrink-0 text-xs font-mono text-stone-600">{p.policy_number}</span>
                <span className="flex-1 text-sm truncate" title={p.summary || p.title}>{p.title}</span>
                <span className="w-28 flex-shrink-0 text-xs text-stone-500">{p.domain || '—'}</span>
                <span className="w-16 flex-shrink-0 text-xs text-stone-500 text-right tabular-nums">{p.provision_count || 0}</span>
                <span className="w-20 flex-shrink-0 text-xs text-stone-500 text-right tabular-nums">{totalLinked}</span>
                <span className="w-28 flex-shrink-0 text-right">
                  {totalLinked > 0 ? (
                    <span className="inline-flex gap-1 text-[10px] tabular-nums">
                      <span className="text-emerald-600">{covered}</span>
                      <span className="text-stone-300">/</span>
                      <span className="text-amber-600">{partial}</span>
                      <span className="text-stone-300">/</span>
                      <span className="text-red-600">{gap}</span>
                      {conflicting > 0 && <>
                        <span className="text-stone-300">/</span>
                        <span className="text-purple-600">{conflicting}</span>
                      </>}
                    </span>
                  ) : (
                    <span className="text-[10px] text-stone-400">—</span>
                  )}
                </span>
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="bg-stone-50 border-t border-stone-200 px-4 py-4">
                  {detailLoading ? (
                    <Spinner />
                  ) : detail?.policy ? (
                    <PolicyDetail detail={detail} />
                  ) : (
                    <p className="text-xs text-stone-400">Failed to load details</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PolicyDetail({ detail }) {
  const { policy, provisions, obligations } = detail;
  const [showProvisions, setShowProvisions] = useState(false);
  const [oblFilter, setOblFilter] = useState('all');
  const [expandedObl, setExpandedObl] = useState(null);

  const oblCounts = {
    total: obligations.length,
    covered: obligations.filter(o => o.status === 'COVERED').length,
    partial: obligations.filter(o => o.status === 'PARTIAL').length,
    gap: obligations.filter(o => o.status === 'GAP').length,
    conflicting: obligations.filter(o => o.status === 'CONFLICTING').length,
  };

  let filteredObls = obligations;
  if (oblFilter !== 'all') {
    filteredObls = obligations.filter(o => o.status === oblFilter);
  }

  return (
    <div className="space-y-4">
      {/* Policy info */}
      <div className="grid grid-cols-2 gap-4 text-xs">
        {policy.summary && (
          <div className="col-span-2">
            <p className="font-medium text-stone-500 mb-1">Summary</p>
            <p className="text-stone-700">{policy.summary}</p>
          </div>
        )}
        {policy.purpose && (
          <div className="col-span-2">
            <p className="font-medium text-stone-500 mb-1">Purpose</p>
            <p className="text-stone-700">{policy.purpose}</p>
          </div>
        )}
        {policy.effective_date && (
          <div>
            <p className="font-medium text-stone-500 mb-1">Effective Date</p>
            <p>{policy.effective_date}</p>
          </div>
        )}
        {policy.facility_name && (
          <div>
            <p className="font-medium text-stone-500 mb-1">Facility</p>
            <p>{policy.facility_name}</p>
          </div>
        )}
        {policy.dcf_citations && policy.dcf_citations.length > 0 && (
          <div>
            <p className="font-medium text-stone-500 mb-1">DCF Citations</p>
            <p className="font-mono text-stone-600">{policy.dcf_citations.join(', ')}</p>
          </div>
        )}
        {policy.tjc_citations && policy.tjc_citations.length > 0 && (
          <div>
            <p className="font-medium text-stone-500 mb-1">TJC Citations</p>
            <p className="font-mono text-stone-600">{policy.tjc_citations.join(', ')}</p>
          </div>
        )}
      </div>

      {/* Provisions */}
      <div>
        <button
          onClick={() => setShowProvisions(!showProvisions)}
          className="text-xs font-medium text-stone-500 hover:text-stone-700 flex items-center gap-1"
        >
          <span className={`transition-transform ${showProvisions ? 'rotate-90' : ''}`}>▶</span>
          Provisions ({provisions.length})
        </button>
        {showProvisions && (
          <div className="mt-2 border border-stone-200 rounded-lg bg-white divide-y divide-stone-100 max-h-64 overflow-y-auto">
            {provisions.map((prov, i) => (
              <div key={prov.id || i} className="px-3 py-2 text-xs">
                {prov.section && <span className="font-mono text-stone-400 mr-2">{prov.section}</span>}
                <span className="text-stone-700">{prov.text}</span>
              </div>
            ))}
            {provisions.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-stone-400">No provisions indexed</div>
            )}
          </div>
        )}
      </div>

      {/* Linked obligations */}
      {obligations.length > 0 && (
        <div>
          <p className="text-xs font-medium text-stone-500 mb-2">
            Linked Obligations ({obligations.length})
            {oblCounts.total > 0 && (
              <span className="ml-2 font-normal">
                <span className="text-emerald-600">{oblCounts.covered} covered</span>
                {' · '}
                <span className="text-amber-600">{oblCounts.partial} partial</span>
                {' · '}
                <span className="text-red-600">{oblCounts.gap} gaps</span>
                {oblCounts.conflicting > 0 && <>{' · '}<span className="text-purple-600">{oblCounts.conflicting} conflicting</span></>}
              </span>
            )}
          </p>

          <div className="flex gap-1 mb-2">
            {['all', 'GAP', 'PARTIAL', 'COVERED', 'CONFLICTING'].map(s => {
              const count = s === 'all' ? obligations.length : oblCounts[s.toLowerCase()] || 0;
              if (count === 0 && s !== 'all') return null;
              return (
                <button key={s} onClick={() => setOblFilter(s)}
                  className={`px-2 py-0.5 text-[10px] rounded-full ${oblFilter === s ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-500 hover:bg-stone-200'}`}
                >
                  {s === 'all' ? 'All' : s} ({count})
                </button>
              );
            })}
          </div>

          <div className="border border-stone-200 rounded-lg bg-white divide-y divide-stone-100 max-h-96 overflow-y-auto">
            {filteredObls.slice(0, 50).map((obl, i) => {
              const effectiveStatus = obl.human_status || obl.status;
              const isOblExpanded = expandedObl === (obl.obligation_id || i);
              const hasDetail = obl.gap_detail || obl.confidence || obl.match_method;
              return (
                <div key={obl.obligation_id || i}>
                  <button
                    onClick={() => setExpandedObl(isOblExpanded ? null : (obl.obligation_id || i))}
                    className="w-full px-3 py-2 flex items-start gap-2 text-xs text-left hover:bg-stone-50"
                  >
                    <span className="w-14 pt-0.5 flex-shrink-0"><Badge status={effectiveStatus} /></span>
                    <span className="w-36 flex-shrink-0 font-mono text-stone-600 pt-0.5">{obl.citation}</span>
                    <span className="flex-1 min-w-0 text-stone-700 line-clamp-2">{obl.requirement}</span>
                    <span className="w-24 flex-shrink-0 text-stone-400 text-right pt-0.5">{obl.source_name}</span>
                  </button>
                  {isOblExpanded && (
                    <div className="px-3 pb-3 bg-stone-50 border-t border-stone-100">
                      <div className="ml-14 grid grid-cols-2 gap-3 text-xs mt-2">
                        <div>
                          <p className="font-medium text-stone-500 mb-0.5">Assessment</p>
                          <p>
                            <Badge status={obl.status} />
                            {obl.confidence && <span className="ml-1 text-stone-400">({obl.confidence})</span>}
                          </p>
                        </div>
                        {obl.match_method && (
                          <div>
                            <p className="font-medium text-stone-500 mb-0.5">Match</p>
                            <p className="text-stone-600">{obl.match_method}{obl.match_score ? ` (score: ${obl.match_score})` : ''}</p>
                          </div>
                        )}
                        {obl.gap_detail && (
                          <div className="col-span-2">
                            <p className="font-medium text-stone-500 mb-0.5">Gap Detail</p>
                            <p className="text-stone-700 bg-white p-2 rounded border border-stone-200">{obl.gap_detail}</p>
                          </div>
                        )}
                        {obl.human_status && (
                          <div className="col-span-2">
                            <p className="font-medium text-indigo-600 mb-0.5">Human Review</p>
                            <p><Badge status={obl.human_status} />{obl.review_notes && <span className="ml-2 text-stone-600">{obl.review_notes}</span>}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredObls.length > 50 && (
              <div className="px-3 py-2 text-center text-[11px] text-stone-400">
                Showing 50 of {filteredObls.length}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
