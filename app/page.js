'use client';
import { useState, useEffect } from 'react';
import { MODES } from '@/components/shared';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import DashboardMode from '@/components/DashboardMode';
import FacilityViewMode from '@/components/FacilityViewMode';
import GapReportMode from '@/components/GapReportMode';
import FacilityMatrixMode from '@/components/FacilityMatrixMode';
import RegulationsMode from '@/components/RegulationsMode';
import PoliciesMode from '@/components/PoliciesMode';
import PolicyRewriteMode from '@/components/PolicyRewriteMode';
import ActionsMode from '@/components/ActionsMode';
import PipelineMode from '@/components/PipelineMode';

export default function PolicyGuard() {
  const [mode, setMode] = useState('dashboard');
  const [selectedFacility, setSelectedFacility] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);

  // Pipeline state — lives here so it persists across mode switches
  const [pipelineRunning, setPipelineRunning] = useState(null);
  const [pipelineLog, setPipelineLog] = useState([]);
  const pipelineAddLog = (msg) => setPipelineLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  useEffect(() => {
    fetch('/api/v6/dashboard')
      .then(r => r.json())
      .then(d => setDashboardData(d))
      .catch(err => console.error('Dashboard load:', err));
  }, []);

  const navigate = (newMode, facilityId) => {
    if (newMode === 'facility' && facilityId) {
      setSelectedFacility(facilityId);
      setMode('facility');
    } else {
      setMode(newMode);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <nav className="w-56 bg-stone-900 text-stone-300 flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-stone-800">
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 bg-white text-stone-900 rounded flex items-center justify-center text-xs font-bold">PG</span>
            <div>
              <p className="text-sm font-semibold text-white">PolicyGuard</p>
              <p className="text-[10px] text-stone-500">v7 · ARS Compliance</p>
            </div>
          </div>
        </div>
        <div className="flex-1 p-2 space-y-0.5">
          {MODES.map(m => (
            <button
              key={m.id}
              onClick={() => navigate(m.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                mode === m.id ? 'bg-stone-800 text-white' : 'hover:bg-stone-800/50 hover:text-stone-200'
              }`}
            >
              <span className="w-5 text-center opacity-60">{m.icon}</span>
              {m.label}
              {m.id === 'pipeline' && pipelineRunning && (
                <span className="ml-auto w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              )}
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-stone-800">
          <p className="text-[10px] text-stone-600">Advanced Recovery Systems</p>
          <p className="text-[10px] text-stone-600">CLO Dashboard</p>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto p-6">
          <ErrorBoundary key={mode}>
          {mode === 'pipeline' && <PipelineMode running={pipelineRunning} setRunning={setPipelineRunning} runLog={pipelineLog} setRunLog={setPipelineLog} addLog={pipelineAddLog} />}
          {mode === 'dashboard' && <DashboardMode data={dashboardData} onNavigate={navigate} />}
          {mode === 'facility' && <FacilityViewMode facilityId={selectedFacility} onNavigate={navigate} />}
          {mode === 'regulations' && <RegulationsMode onNavigate={navigate} />}
          {mode === 'gaps' && <GapReportMode />}
          {mode === 'rewrite' && <PolicyRewriteMode />}
          {mode === 'actions' && <ActionsMode />}
          {mode === 'facilities' && <FacilityMatrixMode />}
          {mode === 'policies' && <PoliciesMode />}
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
