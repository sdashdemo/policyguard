import { useState, useEffect } from 'react';
import { Badge, Spinner, EmptyState } from './shared';

export default function PolicyRewriteMode() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPolicy, setSelectedPolicy] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteResult, setRewriteResult] = useState(null);

  useEffect(() => {
    fetch('/api/v6/policies')
      .then(r => r.json())
      .then(d => {
        // Sort by gap+partial count descending, filter to policies with gaps
        const withGaps = (d.policies || [])
          .map(p => ({
            ...p,
            gaps: Number(p.gap_count || 0),
            partials: Number(p.partial_count || 0),
            total_issues: Number(p.gap_count || 0) + Number(p.partial_count || 0),
          }))
          .filter(p => p.total_issues > 0)
          .sort((a, b) => b.total_issues - a.total_issues);
        setPolicies(withGaps);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const selectPolicy = (policy) => {
    setSelectedPolicy(policy);
    setRewriteResult(null);
    setDetailLoading(true);
    fetch(`/api/v6/policies?id=${policy.id}`)
      .then(r => r.json())
      .then(d => { setDetail(d); setDetailLoading(false); })
      .catch(() => setDetailLoading(false));
  };

  const handleRewrite = async () => {
    if (!selectedPolicy) return;
    setRewriting(true);
    setRewriteResult(null);
    try {
      const res = await fetch('/api/v6/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policy_id: selectedPolicy.id,
          policy_number: selectedPolicy.policy_number,
        }),
      });
      if (res.ok && res.headers.get('content-type')?.includes('text/plain')) {
        const text = await res.text();
        setRewriteResult({ output: text });
      } else if (res.ok) {
        const data = await res.json();
        setRewriteResult(data);
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setRewriteResult({ error: err.error || 'Rewrite failed' });
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
        <p className="text-sm text-stone-500">Policies ranked by unresolved gaps and partials — select one to generate AI-drafted revisions</p>
      </div>

      {!selectedPolicy ? (
        <div className="card divide-y divide-stone-100">
          <div className="px-4 py-2 bg-stone-50 rounded-t-lg border-b border-stone-200 flex items-center text-xs font-medium text-stone-500">
            <span className="w-28">Policy #</span>
            <span className="flex-1 ml-2">Title</span>
            <span className="w-24 ml-2">Domain</span>
            <span className="w-16 text-center ml-2">Gaps</span>
            <span className="w-16 text-center ml-2">Partials</span>
            <span className="w-20 text-right ml-2">Action</span>
          </div>
          {policies.length === 0 && <EmptyState message="No policies with gaps found — run assessments first" />}
          {policies.map((p) => (
            <div key={p.id} className="px-4 py-2.5 row-hover flex items-center gap-2">
              <span className="w-28 flex-shrink-0 text-xs font-mono text-stone-600">{p.policy_number}</span>
              <span className="flex-1 text-sm truncate">{p.title}</span>
              <span className="w-24 flex-shrink-0 text-xs text-stone-500">{p.domain || '—'}</span>
              <span className="w-16 text-center text-xs">
                {p.gaps > 0 && <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-700 ring-1 ring-red-200">{p.gaps}</span>}
              </span>
              <span className="w-16 text-center text-xs">
                {p.partials > 0 && <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">{p.partials}</span>}
              </span>
              <span className="w-20 text-right">
                <button onClick={() => selectPolicy(p)} className="text-xs px-2 py-1 bg-stone-900 text-white rounded hover:bg-stone-800">Select</button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={() => { setSelectedPolicy(null); setRewriteResult(null); setDetail(null); }} className="text-xs text-stone-400 hover:text-stone-700">← Back to policy list</button>

          <div className="card p-4">
            <h2 className="font-semibold">{selectedPolicy.policy_number} — {selectedPolicy.title}</h2>
            <p className="text-sm text-stone-500 mt-1">{selectedPolicy.gaps} gaps · {selectedPolicy.partials} partials · {selectedPolicy.domain || 'no domain'}</p>

            {detailLoading ? <Spinner /> : detail ? (
              <div className="mt-3 space-y-2">
                {detail.policy?.summary && (
                  <p className="text-xs text-stone-600">{detail.policy.summary}</p>
                )}
                <p className="text-xs font-medium text-stone-500 mt-3">Unresolved obligations ({detail.obligations?.filter(o => o.status === 'GAP' || o.status === 'PARTIAL').length}):</p>
                <div className="max-h-64 overflow-y-auto border border-stone-200 rounded-lg divide-y divide-stone-100">
                  {(detail.obligations || [])
                    .filter(o => o.status === 'GAP' || o.status === 'PARTIAL')
                    .slice(0, 30)
                    .map((obl, i) => (
                      <div key={obl.obligation_id || i} className="text-xs p-2 hover:bg-stone-50">
                        <div className="flex items-start gap-2">
                          <Badge status={obl.status} />
                          <span className="font-mono text-stone-500">{obl.citation}</span>
                        </div>
                        <p className="mt-1 text-stone-700">{obl.requirement}</p>
                        {obl.gap_detail && <p className="mt-1 text-red-600">{obl.gap_detail}</p>}
                      </div>
                    ))}
                </div>
                {(detail.obligations || []).filter(o => o.status === 'GAP' || o.status === 'PARTIAL').length > 30 && (
                  <p className="text-xs text-stone-400">+ more — see Gap Report for full list</p>
                )}
              </div>
            ) : null}

            <div className="mt-4">
              <button
                onClick={handleRewrite}
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
              <pre className="text-xs whitespace-pre-wrap bg-stone-50 p-4 rounded max-h-[600px] overflow-y-auto font-mono leading-relaxed">{rewriteResult.output || JSON.stringify(rewriteResult, null, 2)}</pre>
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
