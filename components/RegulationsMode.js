import { useState, useEffect } from 'react';
import { CoverageBar, Spinner, EmptyState } from './shared';

export default function RegulationsMode({ onNavigate }) {
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

