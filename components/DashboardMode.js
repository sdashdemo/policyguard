import { useState, useEffect } from 'react';
import { Badge, CoverageBar, StatCard, Spinner, EmptyState } from './shared';

export default function DashboardMode({ data, onNavigate }) {
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

