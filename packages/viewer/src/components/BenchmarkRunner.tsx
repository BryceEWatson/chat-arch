/**
 * Dev-only benchmark harness — iterate the (embedder × clusterer × postproc)
 * matrix defined in `research/benchmark-harness-plan.md` against the
 * user's persisted corpus. Emits a CSV for pasting into a spreadsheet
 * and persists results to `chat-arch-bench-results` (dedicated DB).
 *
 * Scope (v1): the EMBEDDER sweep. Holds `complete-linkage + reduce_outliers`
 * constant across rows (i.e. today's production clusterer+postproc).
 * Adding the UMAP/k-means clusterer sweep and the postproc sweep
 * requires surgery in `semanticClassify.ts` to accept a clusterer
 * option — tracked as a v2 followup.
 *
 * This component is mounted ONLY from `apps/standalone/src/pages/_bench.astro`.
 * The underscore prefix keeps Astro from routing it in production
 * builds — see the memo's §1 for the reasoning behind gating at the
 * filename level instead of a runtime DEV check.
 */

import { useEffect, useRef, useState } from 'react';
import { loadUploadedData } from '../data/uploadedDataStore.js';
import type { UploadedCloudData } from '../types.js';
import { createEmbedClient, type EmbedClient } from '../data/embedClient.js';
import { spawnCascadedEmbedClient } from '../data/spawnCascadedEmbedClient.js';
import { classifyUploadedSessions, type SemanticLabelsBundle } from '../data/semanticClassify.js';
import {
  saveBenchResult,
  listBenchResults,
  clearBenchResults,
  type BenchResultRow,
} from '../data/benchResultsStore.js';

/**
 * Benchmark config — one row of the matrix. `pooling` is REQUIRED and
 * MUST match the model's 1_Pooling/config.json. There is no
 * derive-from-modelId heuristic: mismatched pooling produces silently
 * wrong vectors on any non-CLS model (the bug Phase 1 escaped).
 */
interface BenchConfig {
  readonly embedder: string;
  readonly pooling: 'cls' | 'mean';
  readonly cluster: 'complete-linkage';
  readonly postproc: 'reduce-outliers';
}

const MATRIX: readonly BenchConfig[] = [
  // Pooling verified against each model's 1_Pooling/config.json on
  // HF on plan-revision day; re-verify if adding a new row.
  { embedder: 'Xenova/all-MiniLM-L6-v2',             pooling: 'mean', cluster: 'complete-linkage', postproc: 'reduce-outliers' },
  { embedder: 'Xenova/bge-small-en-v1.5',            pooling: 'cls',  cluster: 'complete-linkage', postproc: 'reduce-outliers' },
  { embedder: 'Snowflake/snowflake-arctic-embed-xs', pooling: 'cls',  cluster: 'complete-linkage', postproc: 'reduce-outliers' },
];

function configKey(c: BenchConfig): string {
  return `${c.embedder}:${c.pooling}:${c.cluster}:${c.postproc}`;
}

type LogLine = { level: 'info' | 'warn' | 'error'; message: string; ts: number };

interface RunnerState {
  status: 'idle' | 'loading-data' | 'ready' | 'running' | 'done' | 'aborted' | 'error';
  upload: UploadedCloudData | null;
  activeConfigKey: string | null;
  log: LogLine[];
  savedRows: BenchResultRow[];
  error: string | null;
}

export function BenchmarkRunner(): JSX.Element {
  const [state, setState] = useState<RunnerState>({
    status: 'loading-data',
    upload: null,
    activeConfigKey: null,
    log: [],
    savedRows: [],
    error: null,
  });
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const upload = await loadUploadedData();
      const savedRows = await listBenchResults();
      if (cancelled) return;
      setState((s) => ({
        ...s,
        upload,
        savedRows,
        status: upload === null ? 'error' : 'ready',
        error: upload === null ? 'No persisted upload found. Upload a ZIP on the main page first.' : null,
      }));
    })();
    return (): void => { cancelled = true; };
  }, []);

  const log = (level: LogLine['level'], message: string): void => {
    setState((s) => ({ ...s, log: [...s.log, { level, message, ts: Date.now() }].slice(-200) }));
  };

  const runMatrix = async (): Promise<void> => {
    if (state.upload === null) return;
    abortRef.current = { aborted: false };
    setState((s) => ({ ...s, status: 'running', log: [] }));

    for (const config of MATRIX) {
      if (abortRef.current.aborted) break;
      const key = configKey(config);
      setState((s) => ({ ...s, activeConfigKey: key }));
      log('info', `▶ ${key}`);
      try {
        const row = await runOneConfig(config, state.upload, abortRef.current, log);
        await saveBenchResult(row);
        const savedRows = await listBenchResults();
        setState((s) => ({ ...s, savedRows }));
        log('info', `✓ ${key} — classified=${pct(row.metrics['classified_pct'])}, emergent=${pct(row.metrics['emergent_pct'])}, unlabeled=${pct(row.metrics['unlabeled_pct'])}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log('error', `✗ ${key} — ${msg}`);
      }
    }

    setState((s) => ({
      ...s,
      status: abortRef.current.aborted ? 'aborted' : 'done',
      activeConfigKey: null,
    }));
  };

  const stop = (): void => {
    abortRef.current.aborted = true;
    log('warn', 'Stop requested — finishing the in-flight row before exiting.');
  };

  const resetResults = async (): Promise<void> => {
    if (!window.confirm('Clear all saved benchmark results?')) return;
    await clearBenchResults();
    setState((s) => ({ ...s, savedRows: [] }));
  };

  const downloadCsv = (): void => {
    if (state.savedRows.length === 0) return;
    const csv = toCsv(state.savedRows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bench-results-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: 16, fontFamily: 'ui-monospace, monospace', maxWidth: 1100 }}>
      <h1>Benchmark harness (dev-only)</h1>
      {state.status === 'loading-data' && <p>Loading persisted upload…</p>}
      {state.status === 'error' && <p style={{ color: 'crimson' }}>{state.error}</p>}
      {state.upload && (
        <>
          <p>
            Persisted upload: {state.upload.manifest.sessions.length} sessions,{' '}
            {state.upload.projects?.length ?? 0} projects.
          </p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button
              type="button"
              onClick={runMatrix}
              disabled={state.status === 'running'}
            >
              {state.status === 'running' ? 'Running…' : 'Run matrix'}
            </button>
            <button
              type="button"
              onClick={stop}
              disabled={state.status !== 'running'}
            >
              Stop
            </button>
            <button
              type="button"
              onClick={downloadCsv}
              disabled={state.savedRows.length === 0}
            >
              Download CSV
            </button>
            <button
              type="button"
              onClick={resetResults}
              disabled={state.status === 'running' || state.savedRows.length === 0}
            >
              Reset saved results
            </button>
          </div>
          <table style={{ borderCollapse: 'collapse', marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={th}>Config</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((c) => {
                const key = configKey(c);
                const saved = state.savedRows.find((r) => r.configKey === key);
                const running = state.activeConfigKey === key;
                return (
                  <tr key={key}>
                    <td style={td}>{key}</td>
                    <td style={td}>
                      {running ? 'running…' : saved ? `done (classified=${pct(saved.metrics['classified_pct'])})` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div
            aria-label="log"
            style={{
              border: '1px solid #444',
              background: '#111',
              color: '#ccc',
              padding: 8,
              height: 280,
              overflowY: 'auto',
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {state.log.map((l, i) => (
              <div key={i} style={{ color: l.level === 'error' ? '#f66' : l.level === 'warn' ? '#fc6' : '#ccc' }}>
                [{new Date(l.ts).toISOString().slice(11, 19)}] {l.message}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const th: React.CSSProperties = { textAlign: 'left', padding: '4px 10px', borderBottom: '1px solid #888' };
const td: React.CSSProperties = { padding: '4px 10px', borderBottom: '1px solid #333' };

function pct(v: unknown): string {
  if (typeof v !== 'number') return '—';
  return `${(v * 100).toFixed(1)}%`;
}

async function runOneConfig(
  config: BenchConfig,
  upload: UploadedCloudData,
  abort: { aborted: boolean },
  log: (level: LogLine['level'], message: string) => void,
): Promise<BenchResultRow> {
  const key = configKey(config);
  const spawnClient = (
    prefer?: 'webgpu' | 'wasm',
    forceWebgpuDtype?: 'q4f16' | 'fp16' | 'fp32',
  ): EmbedClient =>
    createEmbedClient({
      modelId: config.embedder,
      pooling: config.pooling,
      ...(prefer ? { preferDevice: prefer } : {}),
      ...(forceWebgpuDtype ? { forceWebgpuDtype } : {}),
    });

  const cascadeStart = performance.now();
  const cascade = await spawnCascadedEmbedClient({
    spawnClient,
    readDevicePref: false,
    saveDevicePref: false,
    onLog: (level, _source, message) => log(level === 'debug' ? 'info' : level, message),
  });
  const downloadS = (performance.now() - cascadeStart) / 1000;

  const classifyStart = performance.now();
  const bundle: SemanticLabelsBundle = await classifyUploadedSessions(upload, cascade.client, {
    modelId: config.embedder,
  });
  const embedRuntimeS = (performance.now() - classifyStart) / 1000;

  cascade.client.dispose();

  if (abort.aborted) {
    throw new Error('aborted before results recorded');
  }

  const metrics = computeBucketMetrics(bundle, upload);
  return {
    version: 1,
    configKey: key,
    modelId: config.embedder,
    pooling: config.pooling,
    clusterConfig: config.cluster,
    postproc: config.postproc,
    completedAt: Date.now(),
    metrics: {
      ...metrics,
      download_s: Number(downloadS.toFixed(2)),
      embed_runtime_s: Number(embedRuntimeS.toFixed(2)),
      device: cascade.device,
      dtype: cascade.dtype,
      cascade_steps: cascade.cascadeSteps,
    },
    sample: pickSample(bundle, upload, 3, 10),
  };
}

function computeBucketMetrics(
  bundle: SemanticLabelsBundle,
  upload: UploadedCloudData,
): Record<string, number> {
  const total = upload.manifest.sessions.filter((s) => s.source === 'cloud').length;
  if (total === 0) {
    return { classified_pct: 0, emergent_pct: 0, unlabeled_pct: 0, n_topics: 0 };
  }
  let classified = 0;
  let emergent = 0;
  let unlabeled = 0;
  const topics = new Set<string>();
  for (const session of upload.manifest.sessions) {
    if (session.source !== 'cloud') continue;
    const label = bundle.labels.get(session.id);
    if (!label || label.projectId === null) {
      unlabeled += 1;
      continue;
    }
    if (label.projectId.startsWith('~')) emergent += 1;
    else classified += 1;
    topics.add(label.projectId);
  }
  return {
    classified_pct: classified / total,
    emergent_pct: emergent / total,
    unlabeled_pct: unlabeled / total,
    n_topics: topics.size,
  };
}

function pickSample(
  bundle: SemanticLabelsBundle,
  upload: UploadedCloudData,
  nClusters: number,
  titlesPerCluster: number,
): BenchResultRow['sample'] {
  const byCluster = new Map<string, string[]>();
  for (const session of upload.manifest.sessions) {
    if (session.source !== 'cloud') continue;
    const label = bundle.labels.get(session.id);
    if (!label || label.projectId === null || !label.projectId.startsWith('~')) continue;
    const arr = byCluster.get(label.projectId) ?? [];
    arr.push(session.title);
    byCluster.set(label.projectId, arr);
  }
  const sorted = [...byCluster.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, nClusters);
  return sorted.map(([clusterLabel, titles]) => ({
    clusterLabel,
    size: titles.length,
    memberTitles: titles.slice(0, titlesPerCluster),
  }));
}

function toCsv(rows: readonly BenchResultRow[]): string {
  if (rows.length === 0) return '';
  const cols = [
    'configKey',
    'modelId',
    'pooling',
    'cluster',
    'postproc',
    'classified_pct',
    'emergent_pct',
    'unlabeled_pct',
    'n_topics',
    'download_s',
    'embed_runtime_s',
    'device',
    'dtype',
    'cascade_steps',
    'completedAt',
  ];
  const lines = [cols.join(',')];
  for (const r of rows) {
    const row = [
      r.configKey,
      r.modelId,
      r.pooling,
      r.clusterConfig,
      r.postproc,
      r.metrics['classified_pct'] ?? '',
      r.metrics['emergent_pct'] ?? '',
      r.metrics['unlabeled_pct'] ?? '',
      r.metrics['n_topics'] ?? '',
      r.metrics['download_s'] ?? '',
      r.metrics['embed_runtime_s'] ?? '',
      r.metrics['device'] ?? '',
      r.metrics['dtype'] ?? '',
      r.metrics['cascade_steps'] ?? '',
      new Date(r.completedAt).toISOString(),
    ].map((v) => csvEscape(String(v)));
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function csvEscape(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
