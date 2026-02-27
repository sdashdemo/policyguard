import { useState, useEffect } from 'react';
import { Spinner, EmptyState, LOC_OPTIONS, ACCREDITATION_OPTIONS, STATES } from './shared';

export default function FacilityMatrixMode() {
  const [facilities, setFacilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);

  useEffect(() => {
    fetch('/api/v6/facilities')
      .then(r => r.json())
      .then(d => { setFacilities(d.facilities || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const toggleAttr = async (facilityId, field, value) => {
    const fac = facilities.find(f => f.facility_id === facilityId);
    if (!fac) return;
    const current = fac[field] || [];
    const updated = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    
    setSaving(facilityId);
    await fetch('/api/v6/facilities', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: facilityId, [field]: updated }),
    });
    setFacilities(prev => prev.map(f =>
      f.facility_id === facilityId ? { ...f, [field]: updated } : f
    ));
    setSaving(null);
  };

  if (loading) return <Spinner />;

  return (
    <div className="page-enter space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Facility Matrix</h1>
        <p className="text-sm text-stone-500">Levels of care (editable) · License types (from master data) · Accreditations (editable)</p>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-stone-50 border-b border-stone-200">
              <th className="px-3 py-2 text-left font-semibold text-stone-600 sticky left-0 bg-stone-50 min-w-[200px]">Facility</th>
              <th className="px-2 py-2 text-center font-medium text-stone-500">State</th>
              {LOC_OPTIONS.map(loc => (
                <th key={loc.id} className="px-2 py-2 text-center font-medium text-stone-500 whitespace-nowrap">{loc.label}</th>
              ))}
              <th className="px-1 py-2 border-l border-stone-100" />
              {ACCREDITATION_OPTIONS.map(acc => (
                <th key={acc.id} className="px-2 py-2 text-center font-medium text-stone-500 whitespace-nowrap">{acc.label}</th>
              ))}
              <th className="px-1 py-2 border-l border-stone-100" />
              <th className="px-3 py-2 text-left font-medium text-stone-500 min-w-[250px]">License Types</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {facilities.map(fac => (
              <tr key={fac.facility_id} className={`row-hover ${saving === fac.facility_id ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 font-medium sticky left-0 bg-white">
                  {fac.name}
                  {fac.abbreviation && <span className="text-stone-400 ml-1">({fac.abbreviation})</span>}
                </td>
                <td className="px-2 py-2 text-center text-stone-500">{fac.state}</td>
                {LOC_OPTIONS.map(loc => (
                  <td key={loc.id} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={(fac.levels_of_care || []).includes(loc.id)}
                      onChange={() => toggleAttr(fac.facility_id, 'levels_of_care', loc.id)}
                      className="rounded"
                    />
                  </td>
                ))}
                <td className="px-1 py-2 border-l border-stone-100" />
                {ACCREDITATION_OPTIONS.map(acc => (
                  <td key={acc.id} className="px-2 py-2 text-center">
                    <input
                      type="checkbox"
                      checked={(fac.accreditations || []).includes(acc.id)}
                      onChange={() => toggleAttr(fac.facility_id, 'accreditations', acc.id)}
                      className="rounded"
                    />
                  </td>
                ))}
                <td className="px-1 py-2 border-l border-stone-100" />
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(fac.license_types || []).map(lt => (
                      <span key={lt} className="inline-block px-1.5 py-0.5 bg-stone-100 text-stone-600 rounded text-[10px]">
                        {lt.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── REGULATIONS MODE ───────────────────────────────────────

