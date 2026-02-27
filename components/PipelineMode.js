import { useState, useEffect, useCallback } from 'react';
import { Spinner } from './shared';

export default function PipelineMode({ running, setRunning, runLog, setRunLog, addLog }) {
  const [steps, setSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploadingReg, setUploadingReg] = useState(false);
  const [uploadingPolicies, setUploadingPolicies] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);

  const refreshPipeline = () => {
    fetch('/api/v6/pipeline')
      .then(r => r.json())
      .then(d => { setSteps(d.steps || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { refreshPipeline(); }, []);

  // ── Upload a single regulatory source ──
  const handleRegUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingReg(true);
    addLog(`Uploading regulatory source: ${file.name}`);

    const form = new FormData();
    form.append('file', file);
    form.append('type', 'reg_source');

    try {
      const res = await fetch('/api/v6/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (data.ok) {
        const c = data.classified;
        addLog(`✓ Uploaded ${file.name} — ${data.text_length.toLocaleString()} chars`);
        addLog(`  Auto-classified: "${c.name}" | ${c.state || 'Federal/National'} | ${c.source_type} | Citation: ${c.citation_root || '—'}`);
      } else {
        addLog(`✗ Error: ${data.error}`);
      }
    } catch (err) {
      addLog(`✗ Upload failed: ${err.message}`);
    }
    e.target.value = '';
    setUploadingReg(false);
    refreshPipeline();
  };

  // ── Batch upload policies ──
  const handlePolicyUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploadingPolicies(true);
    addLog(`Uploading ${files.length} policy files...`);

    // Upload in batches of 50
    let uploaded = 0;
    let errors = 0;
    for (let i = 0; i < files.length; i += 50) {
      const batch = files.slice(i, i + 50);
      const form = new FormData();
      batch.forEach(f => form.append('files', f));

      try {
        const res = await fetch('/api/v6/upload', { method: 'PUT', body: form });
        const data = await res.json();
        uploaded += data.uploaded || 0;
        errors += data.errors || 0;
        const skippedCount = data.skipped || 0;
        setUploadProgress(`${uploaded}/${files.length} uploaded${skippedCount ? `, ${skippedCount} skipped (already exist)` : ''}`);
        if (data.errors_detail?.length) {
          data.errors_detail.forEach(e => addLog(`  ✗ ${e.filename}: ${e.error}`));
        }
      } catch (err) {
        addLog(`  ✗ Batch error: ${err.message}`);
        errors += batch.length;
      }
    }

    addLog(`✓ Policy upload complete: ${uploaded} uploaded, ${errors} errors`);
    e.target.value = '';
    setUploadingPolicies(false);
    setUploadProgress(null);
    refreshPipeline();
  };

  // ── Run pipeline step ──
  const runStep = async (stepId) => {
    setRunning(stepId);

    if (stepId === 'extract_obligations') {
      addLog('Fetching regulatory source list...');
      try {
        const listRes = await fetch('/api/v6/extract');
        const listData = await listRes.json();
        const sources = listData.sources || [];
        addLog(`Found ${sources.length} sources to extract from`);

        for (const src of sources) {
          if (Number(src.obligation_count) > 0) {
            addLog(`  ⏭ ${src.name} — already has ${src.obligation_count} obligations, skipping`);
            continue;
          }
          addLog(`  ⏳ ${src.name} (${Number(src.text_length).toLocaleString()} chars)...`);
          let chunkIdx = 0;
          let totalInserted = 0;
          let done = false;
          while (!done) {
            try {
              const res = await fetch('/api/v6/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_id: src.id, chunk_index: chunkIdx }),
              });
              const data = await res.json();
              if (!data.ok) {
                addLog(`    ✗ Chunk ${chunkIdx}: ${data.error}`);
                break;
              }
              if (data.done) {
                done = true;
              } else {
                totalInserted += data.inserted || 0;
                addLog(`    Chunk ${data.chunk_index + 1}/${data.total_chunks}: ${data.extracted} found, ${data.inserted} inserted`);
                if (data.next_chunk !== null) {
                  chunkIdx = data.next_chunk;
                } else {
                  done = true;
                }
              }
            } catch (err) {
              addLog(`    ✗ Chunk ${chunkIdx}: ${err.message}`);
              break;
            }
          }
          addLog(`  ✓ ${src.name}: ${totalInserted} obligations inserted`);
        }
        addLog('✓ Extraction complete');
      } catch (err) {
        addLog(`✗ Extraction error: ${err.message}`);
      }
    }

    if (stepId === 'index_policies') {
      addLog('Starting policy indexing...');
      try {
        let done = false;
        let totalIndexed = 0;
        let totalProvisions = 0;
        while (!done) {
          const res = await fetch('/api/v6/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const data = await res.json();
          if (!data.ok) {
            addLog(`  ✗ Error: ${data.error}`);
            break;
          }
          if (data.done) {
            done = true;
          } else if (data.skipped) {
            addLog(`  ⏭ Skipped: ${data.reason}`);
          } else {
            totalIndexed++;
            totalProvisions += data.provisions_inserted || 0;
            addLog(`  ✓ ${data.policy_number || '?'} — ${data.title || '?'} (${data.provisions_inserted} provisions) [${data.remaining} left]`);
          }
        }
        addLog(`✓ Indexing complete: ${totalIndexed} policies, ${totalProvisions} provisions`);
      } catch (err) {
        addLog(`✗ Indexing error: ${err.message}`);
      }
    }

    if (stepId === 'embed') {
      addLog('Generating embeddings (Voyage AI)...');
      let remaining = 999;
      let rounds = 0;
      while (remaining > 0 && rounds < 50) {
        try {
          const res = await fetch('/api/v6/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: 'all' }),
          });
          const data = await res.json();
          remaining = Number(data.remaining?.obls_remaining || 0) + Number(data.remaining?.provs_remaining || 0);
          addLog(`  Embedded batch — ${remaining} remaining`);
          rounds++;
        } catch (err) {
          addLog(`✗ Embedding error: ${err.message}`);
          break;
        }
      }
      addLog(`✓ Embedding complete after ${rounds} batches`);
    }

    if (stepId === 'assess') {
      addLog('Starting coverage assessment (hybrid matching + Claude)...');
      try {
        // Get initial stats
        const statsRes = await fetch('/api/v6/assess');
        const stats = await statsRes.json();
        addLog(`${stats.total_obligations} obligations total, ${stats.unassessed} unassessed`);

        let done = false;
        let runId = null;
        let totalAssessed = 0;
        const statusCounts = { COVERED: 0, PARTIAL: 0, GAP: 0, CONFLICTING: 0, NEEDS_LEGAL_REVIEW: 0 };

        while (!done) {
          try {
            const res = await fetch('/api/v6/assess', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ map_run_id: runId }),
            });
            const data = await res.json();
            if (!data.ok) {
              addLog(`  ✗ Error: ${data.error}`);
              break;
            }
            if (data.done) {
              done = true;
            } else {
              if (!runId) runId = data.map_run_id;
              totalAssessed++;
              statusCounts[data.status] = (statusCounts[data.status] || 0) + 1;
              const policyInfo = data.covering_policy ? ` → ${data.covering_policy}` : '';
              addLog(`  ${data.status === 'COVERED' ? '✓' : data.status === 'GAP' ? '✗' : '◐'} ${data.citation}: ${data.status}${policyInfo} (${data.candidates} candidates) [${data.remaining} left]`);
            }
          } catch (err) {
            addLog(`  ✗ Error: ${err.message}`);
            break;
          }
        }
        addLog(`✓ Assessment complete: ${totalAssessed} assessed`);
        addLog(`  COVERED: ${statusCounts.COVERED} | PARTIAL: ${statusCounts.PARTIAL} | GAP: ${statusCounts.GAP} | CONFLICTING: ${statusCounts.CONFLICTING} | NEEDS REVIEW: ${statusCounts.NEEDS_LEGAL_REVIEW}`);
      } catch (err) {
        addLog(`✗ Assessment error: ${err.message}`);
      }
    }

    setRunning(null);
    refreshPipeline();
  };

  if (loading) return <Spinner />;

  const stepColors = {
    done: 'bg-emerald-500',
    ready: 'bg-amber-400',
    blocked: 'bg-stone-300',
    pending: 'bg-stone-300',
  };

  return (
    <div className="page-enter space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Pipeline</h1>
        <p className="text-sm text-stone-500">Upload documents and run the assessment pipeline step by step</p>
      </div>

      {/* Pipeline status */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Pipeline Status</p>
        {steps.map(step => (
          <div key={step.id} className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${stepColors[step.status]}`} />
            <div className="flex-1">
              <p className="text-sm font-medium">{step.label}</p>
              <p className="text-xs text-stone-400">{step.detail}</p>
            </div>
            {(step.status === 'ready' || step.status === 'done') && step.id !== 'upload_regs' && step.id !== 'upload_policies' && (
              <button
                onClick={() => runStep(step.id)}
                disabled={running !== null}
                className="text-xs px-3 py-1 bg-stone-900 text-white rounded hover:bg-stone-800 disabled:opacity-50"
              >
                {running === step.id ? 'Running...' : step.status === 'done' ? 'Re-run' : 'Run'}
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Upload: Regulatory Sources */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Upload Regulatory Source</p>
        <p className="text-sm text-stone-600">Pick a file — Claude will auto-detect the source name, state, type, and citation root</p>
        <div className="flex items-center gap-3">
          <label className="text-xs px-3 py-1.5 bg-stone-900 text-white rounded hover:bg-stone-800 cursor-pointer inline-block">
            {uploadingReg ? 'Uploading & classifying...' : 'Choose File'}
            <input type="file" accept=".docx,.doc,.pdf,.txt" onChange={handleRegUpload} disabled={uploadingReg} className="hidden" />
          </label>
          <p className="text-xs text-stone-400">.doc, .docx, .pdf, or .txt — one at a time</p>
        </div>
      </div>

      {/* Upload: Policies */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Upload Policy Documents</p>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <p className="text-sm">Select all policy Word docs at once — they'll be uploaded in batches of 50</p>
            {uploadProgress && <p className="text-xs text-amber-600 mt-1">{uploadProgress}</p>}
          </div>
          <div>
            <label className="text-xs px-3 py-1.5 bg-stone-900 text-white rounded hover:bg-stone-800 cursor-pointer inline-block">
              {uploadingPolicies ? 'Uploading...' : 'Choose Files'}
              <input type="file" accept=".docx,.doc,.pdf,.txt" multiple onChange={handlePolicyUpload} disabled={uploadingPolicies} className="hidden" />
            </label>
          </div>
        </div>
        <p className="text-xs text-stone-400">Select multiple files (Ctrl/Cmd+A in file picker). Accepts .doc, .docx, .pdf, .txt</p>
      </div>

      {/* Run log */}
      {runLog.length > 0 && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-stone-500 uppercase tracking-wider">Activity Log</p>
            <button onClick={() => setRunLog([])} className="text-xs text-stone-400 hover:text-stone-600">Clear</button>
          </div>
          <div className="bg-stone-950 text-stone-300 rounded p-3 max-h-[300px] overflow-y-auto font-mono text-xs space-y-0.5">
            {runLog.map((line, i) => (
              <div key={i} className={line.includes('✗') ? 'text-red-400' : line.includes('✓') ? 'text-emerald-400' : ''}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CSV EXPORT ─────────────────────────────────────────────

