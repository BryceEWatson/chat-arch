/**
 * ITS builder — Phase 1 Wave 3 (Stream F, task 4).
 *
 * Wires `analysis/config-history.json` (from `configHistory.ts`) +
 * `analysis/composite-outcomes.json` (from `composeOutcomesBuilder.ts`)
 * through the pure `runItsAnalysis` kernel. Emits
 * `analysis/its-analysis.json` for the viewer's ITS surface.
 *
 * Pure I/O wrapper — no kernel duplication. Atomic write.
 */

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CompositeOutcomesFile } from '@chat-arch/schema';
import {
  runItsAnalysis,
  THRESHOLDS,
  type ItsConfigCommit,
  type ItsOutcomeInput,
  type ItsResult,
} from '@chat-arch/analysis';
import type { ConfigHistoryFile } from './configHistory.js';
import { logger } from '../lib/logger.js';

export interface BuildItsOptions {
  outDir: string;
  now: number;
  /**
   * Map from sessionId → terminal-timestamp (Unix ms). The kernel
   * attributes the composite score to when the session ENDED so a
   * config change earlier in a long session can plausibly affect later
   * outcomes. Callers (cli.ts) populate this from the manifest before
   * calling — keeps this module data-driven, not manifest-coupled.
   */
  sessionUpdatedAt: ReadonlyMap<string, number>;
  /** Optional window-days override. */
  windowDays?: number;
}

export interface ItsFile {
  version: 1;
  generatedAt: number;
  windowDays: number;
  results: readonly ItsResult[];
}

export interface BuildItsResult {
  file: ItsFile;
  commitsAnalyzed: number;
}

function atomicWriteJson(target: string, value: unknown): void {
  // Stamped tmp name to avoid concurrent-writer rename races. (S3)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const json = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(tmp, json, 'utf8');
  const fd = openSync(tmp, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

async function loadComposite(outDir: string): Promise<CompositeOutcomesFile | null> {
  try {
    const raw = await readFile(
      path.join(outDir, 'analysis', 'composite-outcomes.json'),
      'utf8',
    );
    return JSON.parse(raw) as CompositeOutcomesFile;
  } catch {
    return null;
  }
}

async function loadConfigHistory(outDir: string): Promise<ConfigHistoryFile | null> {
  try {
    const raw = await readFile(
      path.join(outDir, 'analysis', 'config-history.json'),
      'utf8',
    );
    return JSON.parse(raw) as ConfigHistoryFile;
  } catch {
    return null;
  }
}

export async function buildItsAnalysisFile(
  options: BuildItsOptions,
): Promise<BuildItsResult> {
  const t0 = Date.now();
  const composite = await loadComposite(options.outDir);
  const config = await loadConfigHistory(options.outDir);
  const windowDays = options.windowDays ?? THRESHOLDS.trajectory.rollingWindow;

  if (composite === null || config === null) {
    logger.warn(
      `its: missing prerequisite sidecar (composite-outcomes / config-history) — emitting empty results`,
    );
    const empty: ItsFile = {
      version: 1,
      generatedAt: options.now,
      windowDays,
      results: [],
    };
    atomicWriteJson(
      path.join(options.outDir, 'analysis', 'its-analysis.json'),
      empty,
    );
    return { file: empty, commitsAnalyzed: 0 };
  }

  const outcomesInput: ItsOutcomeInput[] = [];
  for (const c of composite.outcomes) {
    const ts = options.sessionUpdatedAt.get(c.sessionId);
    if (ts === undefined) continue;
    outcomesInput.push({ sessionId: c.sessionId, updatedAt: ts, composite: c });
  }

  const commits: ItsConfigCommit[] = [...config.commits];
  const results = runItsAnalysis(outcomesInput, commits, { windowDays });

  const file: ItsFile = {
    version: 1,
    generatedAt: options.now,
    windowDays,
    results,
  };
  atomicWriteJson(
    path.join(options.outDir, 'analysis', 'its-analysis.json'),
    file,
  );

  logger.info(
    `its: its-analysis.json — ${results.length} commit contrasts over ${outcomesInput.length} outcomes, ${Date.now() - t0}ms`,
  );

  return { file, commitsAnalyzed: results.length };
}
