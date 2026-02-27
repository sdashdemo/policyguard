// components/shared.js — Shared UI components, constants, and utilities

export const MODES = [
  { id: 'pipeline', label: 'Pipeline', icon: '▶' },
  { id: 'dashboard', label: 'Dashboard', icon: '◫' },
  { id: 'facility', label: 'Facility View', icon: '⌂' },
  { id: 'regulations', label: 'Regulations', icon: '§' },
  { id: 'gaps', label: 'Gap Report', icon: '⚠' },
  { id: 'rewrite', label: 'Policy Rewrite', icon: '✎' },
  { id: 'actions', label: 'Action Items', icon: '☑' },
  { id: 'facilities', label: 'Facility Matrix', icon: '⊞' },
  { id: 'policies', label: 'Policies', icon: '◧' },
];

export const STATUS_COLORS = {
  COVERED: { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-200', dot: 'bg-emerald-500' },
  PARTIAL: { bg: 'bg-amber-50', text: 'text-amber-700', ring: 'ring-amber-200', dot: 'bg-amber-500' },
  GAP: { bg: 'bg-red-50', text: 'text-red-700', ring: 'ring-red-200', dot: 'bg-red-500' },
  CONFLICTING: { bg: 'bg-purple-50', text: 'text-purple-700', ring: 'ring-purple-200', dot: 'bg-purple-500' },
  NEEDS_LEGAL_REVIEW: { bg: 'bg-indigo-50', text: 'text-indigo-700', ring: 'ring-indigo-200', dot: 'bg-indigo-500' },
  NOT_APPLICABLE: { bg: 'bg-stone-50', text: 'text-stone-500', ring: 'ring-stone-200', dot: 'bg-stone-400' },
  UNASSESSED: { bg: 'bg-stone-50', text: 'text-stone-400', ring: 'ring-stone-200', dot: 'bg-stone-300' },
};

export const LOC_OPTIONS = [
  { id: 'detox', label: 'Detox' },
  { id: 'residential', label: 'Res' },
  { id: 'php', label: 'PHP' },
  { id: 'iop', label: 'IOP' },
  { id: 'op', label: 'OP' },
  { id: 'mh_rtf', label: 'MH RTF' },
  { id: 'mh_php', label: 'MH PHP' },
  { id: 'otp', label: 'OTP' },
];

export const ACCREDITATION_OPTIONS = [
  { id: 'tjc', label: 'TJC' },
  { id: 'carf', label: 'CARF' },
];

export const STATES = ['FL','GA','MD','NJ','OH','MO','IN','CO','WA','OR'];

export function Badge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.UNASSESSED;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.bg} ${c.text} ring-1 ${c.ring}`}>
      {status === 'NOT_APPLICABLE' ? 'N/A' : status || 'UNASSESSED'}
    </span>
  );
}

export function CoverageBar({ covered = 0, partial = 0, gaps = 0, total = 0 }) {
  if (total === 0) return <div className="coverage-bar w-full"><div className="w-full bg-stone-200" /></div>;
  const pcts = { c: (covered / total) * 100, p: (partial / total) * 100, g: (gaps / total) * 100 };
  return (
    <div className="coverage-bar w-full">
      {pcts.c > 0 && <div className="seg-covered" style={{ width: `${pcts.c}%` }} />}
      {pcts.p > 0 && <div className="seg-partial" style={{ width: `${pcts.p}%` }} />}
      {pcts.g > 0 && <div className="seg-gap" style={{ width: `${pcts.g}%` }} />}
    </div>
  );
}

export function StatCard({ label, value, sub, color = 'text-stone-900' }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-stone-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</p>
      {sub && <p className="text-xs text-stone-400 mt-1">{sub}</p>}
    </div>
  );
}

export function EmptyState({ message }) {
  return <div className="text-center py-16 text-stone-400">{message}</div>;
}

export function Spinner() {
  return <div className="flex items-center justify-center py-12"><div className="w-6 h-6 border-2 border-stone-300 border-t-stone-900 rounded-full animate-spin" /></div>;
}

export function FilterPill({ active, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
        active ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
      }`}
    >
      {label}
    </button>
  );
}

export function exportCSV(rows) {
  const headers = ['citation', 'requirement', 'status', 'confidence', 'gap_detail', 'recommended_policy', 'policy_number', 'source_name', 'source_state'];
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','))
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `policyguard-gaps-${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}
