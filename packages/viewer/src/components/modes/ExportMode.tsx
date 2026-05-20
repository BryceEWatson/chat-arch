import { useEffect, useMemo, useState } from 'react';
import { SidecarEmptyState } from '../SidecarEmptyState.js';
import {
  probeGenerateExports,
  startGenerateExports,
  type ExportManifest,
  type ExportManifestEntry,
  type GenerateExportsOptions,
} from '../../data/exportsLoader.js';

/**
 * Stream J #7 — EXPORT surface.
 *
 * Checklist of available export kinds (counted from the manifest).
 * Filters: date range, project, archetype, outcome-percentile.
 * GENERATE button POSTs to `/api/generate-exports` (mirrors the
 * mineCorrectionsClient pattern); on success, surfaces the output
 * directory path. When `window.electronAPI` is present (placeholder
 * for a future Electron host), the URL is handed off to the system.
 * Otherwise a copy-path / download fallback is rendered.
 */

export interface ExportModeProps {
  manifest: ExportManifest | null;
  /** Optional project list for the dropdown. */
  projectOptions?: ReadonlyArray<{ id: string; label: string }>;
  /** Optional archetype list for the dropdown. */
  archetypeOptions?: ReadonlyArray<{ id: string; label: string }>;
  /** Wave 7 P1 #4 — wire empty-state CTA to the data panel. */
  onOpenDataPanel?: () => void;
}

/** All export kinds the panel knows about. Manifest may report a
 *  subset of these; we render the union so users see what's possible. */
const KINDS: ReadonlyArray<{
  key: 'post-mortem' | 'knowledge-debt' | 'decision-log' | 'trust-report';
  label: string;
  /** The manifest's `kind` value to match against — null when the kind
   *  isn't yet emitted by the exporter (decision-log / trust-report are
   *  planned but not in the v1 manifest). */
  manifestKind: ExportManifestEntry['kind'] | null;
  blurb: string;
}> = [
  {
    key: 'post-mortem',
    label: 'POST-MORTEMS',
    manifestKind: 'post-mortem',
    blurb: 'Markdown post-mortems for `bad`-outcome sessions.',
  },
  {
    key: 'knowledge-debt',
    label: 'KNOWLEDGE-DEBT',
    manifestKind: 'knowledge-debt',
    blurb: 'Topics with recurring asks that never internalize.',
  },
  {
    key: 'decision-log',
    label: 'DECISION-LOGS',
    manifestKind: null,
    blurb: 'One file per project decision; sourced from analysis/decisions.json.',
  },
  {
    key: 'trust-report',
    label: 'TRUST REPORT',
    manifestKind: null,
    blurb: 'Single-file roll-up of the accept/override × landed/didn’t 2×2.',
  },
];

type ExportKey = (typeof KINDS)[number]['key'];

type GenerateState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; outputDir: string | undefined; count: number | undefined }
  | { status: 'error'; message: string };

interface ElectronApiShape {
  openPath?: (p: string) => Promise<void>;
}

function getElectronApi(): ElectronApiShape | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { electronAPI?: ElectronApiShape })
    .electronAPI;
  return api ?? null;
}

export function ExportMode({
  manifest,
  projectOptions = [],
  archetypeOptions = [],
  onOpenDataPanel,
}: ExportModeProps) {
  // Per-kind selection (defaults: enabled when the manifest already has
  // entries; disabled otherwise so a first-time GENERATE produces only
  // what the user explicitly opts into).
  const initialSelection = useMemo(() => {
    const sel: Record<ExportKey, boolean> = {
      'post-mortem': false,
      'knowledge-debt': false,
      'decision-log': false,
      'trust-report': false,
    };
    if (manifest !== null) {
      for (const k of KINDS) {
        if (
          k.manifestKind !== null &&
          manifest.entries.some((e) => e.kind === k.manifestKind)
        ) {
          sel[k.key] = true;
        }
      }
    }
    return sel;
  }, [manifest]);

  const [selection, setSelection] = useState<Record<ExportKey, boolean>>(
    initialSelection,
  );
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [archetypeId, setArchetypeId] = useState<string>('');
  const [outcomePercentile, setOutcomePercentile] = useState<string>('');
  const [genState, setGenState] = useState<GenerateState>({ status: 'idle' });
  const [endpointAvailable, setEndpointAvailable] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    setSelection(initialSelection);
  }, [initialSelection]);

  useEffect(() => {
    let cancelled = false;
    void probeGenerateExports().then((ok) => {
      if (cancelled) return;
      setEndpointAvailable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const countsByKind = useMemo(() => {
    const m: Record<string, number> = {};
    if (manifest === null) return m;
    for (const e of manifest.entries) {
      m[e.kind] = (m[e.kind] ?? 0) + 1;
    }
    return m;
  }, [manifest]);

  if (manifest === null && endpointAvailable === false) {
    return (
      <SidecarEmptyState
        title="NO EXPORT MANIFEST"
        detail="EXPORT reads analysis/exports/manifest.json. Open DATA → SCAN LOCAL to populate it, or generate exports below once a manifest is present."
        {...(onOpenDataPanel ? { onOpenDataPanel } : {})}
        testId="export-empty"
      />
    );
  }

  const onGenerate = async () => {
    setGenState({ status: 'running' });
    const opts: GenerateExportsOptions = {};
    const kinds: Array<'post-mortem' | 'knowledge-debt' | 'decision-log' | 'trust-report'> = [];
    for (const k of KINDS) {
      if (selection[k.key]) kinds.push(k.key);
    }
    if (kinds.length > 0) opts.kinds = kinds;
    const from = parseDateOrUndef(dateFrom);
    if (from !== undefined) opts.dateFrom = from;
    const to = parseDateOrUndef(dateTo);
    if (to !== undefined) opts.dateTo = to;
    if (projectId !== '') opts.projectId = projectId;
    if (archetypeId !== '') opts.archetypeId = archetypeId;
    const pct = parsePercentile(outcomePercentile);
    if (pct !== undefined) opts.outcomePercentile = pct;

    const result = await startGenerateExports(opts);
    if (!result.ok) {
      setGenState({
        status: 'error',
        message: result.error ?? 'generate-exports failed',
      });
      return;
    }
    setGenState({
      status: 'done',
      outputDir: result.outputDir,
      count: result.count,
    });
  };

  const onOpenOutput = async () => {
    if (genState.status !== 'done' || genState.outputDir === undefined) return;
    const electron = getElectronApi();
    if (electron?.openPath !== undefined) {
      try {
        await electron.openPath(genState.outputDir);
        return;
      } catch {
        // Fall through to clipboard path.
      }
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(genState.outputDir);
      } catch {
        // Clipboard write may be blocked by permissions; that's fine.
      }
    }
  };

  const anySelected = Object.values(selection).some((v) => v);
  const generateAvailable = endpointAvailable !== false;

  return (
    <div className="lcars-export" aria-label="export">
      <header className="lcars-export__header">
        <h2 className="lcars-export__title">EXPORT</h2>
        <p className="lcars-export__lead">
          Generate filtered markdown / Obsidian exports from your archive. Each
          checked kind writes a folder under <code>analysis/exports/</code>.
        </p>
      </header>

      <fieldset className="lcars-export__checklist" aria-label="export kinds">
        <legend>EXPORT KINDS</legend>
        {KINDS.map((k) => {
          const count =
            k.manifestKind !== null ? countsByKind[k.manifestKind] ?? 0 : 0;
          return (
            <label
              key={k.key}
              className="lcars-export__kind"
              data-kind={k.key}
            >
              <input
                type="checkbox"
                checked={selection[k.key]}
                onChange={(e) =>
                  setSelection((prev) => ({
                    ...prev,
                    [k.key]: e.target.checked,
                  }))
                }
                data-testid={`kind-${k.key}`}
              />
              <span className="lcars-export__kind-label">{k.label}</span>
              <span className="lcars-export__kind-count">
                {count === 0 ? '—' : count}
              </span>
              <span className="lcars-export__kind-blurb">{k.blurb}</span>
            </label>
          );
        })}
      </fieldset>

      <fieldset className="lcars-export__filters" aria-label="filters">
        <legend>FILTERS</legend>
        <label className="lcars-export__filter">
          <span>DATE FROM</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="filter-date-from"
          />
        </label>
        <label className="lcars-export__filter">
          <span>DATE TO</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="filter-date-to"
          />
        </label>
        <label className="lcars-export__filter">
          <span>PROJECT</span>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            data-testid="filter-project"
          >
            <option value="">(any)</option>
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="lcars-export__filter">
          <span>ARCHETYPE</span>
          <select
            value={archetypeId}
            onChange={(e) => setArchetypeId(e.target.value)}
            data-testid="filter-archetype"
          >
            <option value="">(any)</option>
            {archetypeOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="lcars-export__filter">
          <span>OUTCOME PERCENTILE ≥</span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="0–100"
            value={outcomePercentile}
            onChange={(e) => setOutcomePercentile(e.target.value)}
            data-testid="filter-outcome-percentile"
          />
        </label>
      </fieldset>

      <div className="lcars-export__actions">
        <button
          type="button"
          className="lcars-export__btn lcars-export__btn--primary"
          disabled={
            !anySelected ||
            !generateAvailable ||
            genState.status === 'running'
          }
          onClick={() => void onGenerate()}
          data-testid="generate-btn"
        >
          {genState.status === 'running' ? 'GENERATING…' : '▶ GENERATE'}
        </button>
        {!generateAvailable && (
          <span
            className="lcars-export__hint"
            title="Local-only — install chat-arch on your machine to run exports."
          >
            generation endpoint unavailable (local-only)
          </span>
        )}
      </div>

      {genState.status === 'done' && (
        <div className="lcars-export__result" role="status" aria-live="polite">
          <p>
            Generated{' '}
            {genState.count !== undefined ? `${genState.count} export${genState.count === 1 ? '' : 's'}` : 'exports'}
            {genState.outputDir !== undefined && (
              <>
                {' '}to <code>{genState.outputDir}</code>
              </>
            )}
            .
          </p>
          {genState.outputDir !== undefined && (
            <button
              type="button"
              className="lcars-export__btn lcars-export__btn--secondary"
              onClick={() => void onOpenOutput()}
              data-testid="open-output-btn"
            >
              OPEN / COPY PATH
            </button>
          )}
        </div>
      )}

      {genState.status === 'error' && (
        <div className="lcars-export__error" role="alert">
          <p>Generation failed:</p>
          <pre>{genState.message}</pre>
          <button
            type="button"
            className="lcars-export__btn lcars-export__btn--secondary"
            onClick={() => setGenState({ status: 'idle' })}
          >
            DISMISS
          </button>
        </div>
      )}

      {manifest !== null && manifest.entries.length > 0 && (
        <section className="lcars-export__existing" aria-label="existing exports">
          <h3 className="lcars-export__section-title">EXISTING EXPORTS</h3>
          <ul className="lcars-export__entry-list" role="list">
            {manifest.entries.map((e) => (
              <li
                key={e.relativePath}
                className="lcars-export__entry"
                data-kind={e.kind}
              >
                <span className="lcars-export__entry-kind">{e.kind}</span>
                <code className="lcars-export__entry-path">{e.relativePath}</code>
                {e.title !== undefined && (
                  <span className="lcars-export__entry-title">{e.title}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function parseDateOrUndef(s: string): number | undefined {
  if (s === '') return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : undefined;
}

function parsePercentile(s: string): number | undefined {
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0 || n > 100) return undefined;
  return n;
}
