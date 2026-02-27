import { useState, useEffect } from 'react';
import { FilterPill, Spinner, EmptyState } from './shared';

export default function ActionsMode() {
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
