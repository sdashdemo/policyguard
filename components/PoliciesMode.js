import { useState, useEffect } from 'react';
import { Spinner, EmptyState } from './shared';

export default function PoliciesMode() {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [domainFilter, setDomainFilter] = useState('all');
  const [domains, setDomains] = useState([]);

  useEffect(() => {
    fetch('/api/v6/policies')
      .then(r => r.json())
      .then(d => {
        setPolicies(d.policies || []);
        setDomains(d.domains || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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
          <span className="w-20 ml-2 text-right">Provs</span>
          <span className="w-24 ml-2 text-right">Linked Obls</span>
        </div>
        {filtered.map((p, i) => (
          <div key={p.id || i} className="px-4 py-2.5 row-hover flex items-center gap-2">
            <span className="w-28 flex-shrink-0 text-xs font-mono text-stone-600">{p.policy_number}</span>
            <span className="flex-1 text-sm truncate" title={p.summary}>{p.title}</span>
            <span className="w-32 flex-shrink-0 text-xs text-stone-500">{p.domain || '—'}</span>
            <span className="w-20 flex-shrink-0 text-xs text-stone-500 text-right tabular-nums">{p.provision_count || 0}</span>
            <span className="w-24 flex-shrink-0 text-xs text-stone-500 text-right tabular-nums">{p.assessment_count || 0}</span>
          </div>
        ))}
        {filtered.length === 0 && <EmptyState message="No policies found" />}
      </div>
    </div>
  );
}
