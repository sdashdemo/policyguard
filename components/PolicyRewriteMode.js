import { useState, useEffect } from 'react';
import { Badge, Spinner, EmptyState } from './shared';

export default function PolicyRewriteMode() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPolicy, setSelectedPolicy] = useState(null);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteResult, setRewriteResult] = useState(null);

  useEffect(() => {
    fetch('/api/v6/gaps?status=all')
      .then(r => r.json())
      .then(d => {
        const policyGaps = {};
        for (const row of (d.rows || [])) {
          const pnum = row.recommended_policy || row.policy_number;
          if (!pnum) continue;
          if (!policyGaps[pnum]) policyGaps[pnum] = { policy_number: pnum, title: row.policy_title || pnum, policy_id: row.policy_id, gaps: 0, partials: 0, obligations: [] };
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

  const handleRewrite = async (policy) => {
    setRewriting(true);
    setRewriteResult(null);
    try {
      const res = await fetch('/api/v6/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policy_number: policy.policy_number,
          policy_id: policy.policy_id,
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
                onClick={() => handleRewrite(selectedPolicy)}
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
