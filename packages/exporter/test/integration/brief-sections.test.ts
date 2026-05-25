/**
 * Integration test for the Phase γ + Wave 2 #4 brief inputs wired into
 * the exporter's auto-brief writer (`runSemanticAnalysis`).
 *
 * Background: the daily-brief kernel grew 5 optional inputs in
 * EXPORTER_VERSION 1.4.1 → 1.5.0 (shippedThisWeek, surprises,
 * projectTrajectories, appliedPatternClosures, topStrongPositiveSurprise).
 * The manual REGEN BRIEF endpoint wired them; the exporter's auto-brief
 * writer at `semanticAnalysis.ts` did not. The 4 corresponding sections
 * (Shipped this week, Surprises today, Project trajectories, Applied-
 * pattern closures) silently dropped from every scan-time brief.
 *
 * This test exercises the full exporter pipeline (runAnalysis +
 * runSemanticAnalysis) against the v1.1.0 fixture, plants non-empty
 * `surprises.json` + `project-trajectories.json` on disk between the
 * two phases so the second phase's brief writer reads them, and asserts
 * the produced brief contains the corresponding section headers.
 *
 * Section coverage:
 *   - "► Surprises:" — exercises the surprises-sidecar wire-up.
 *   - "► Project momentum:" — exercises the trajectories sidecar.
 * The "Shipped this week" section is driven by `git log` over the host
 * repo, which makes it environment-dependent — we don't assert it here
 * (it's a no-op when the test runs outside a git repo or on a quiet
 * week). The other two sections are deterministic given the planted
 * sidecars.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionManifest } from '@chat-arch/schema';
import { runAnalysis } from '../../src/analysis/index.js';
import { runSemanticAnalysis } from '../../src/analysis/semanticAnalysis.js';
import { logger } from '../../src/lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(
  __dirname,
  '..',
  'migration',
  'fixtures',
  'v1.1.0',
  'chat-arch-data',
);

let tmpDataDir: string;

beforeEach(async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-brief-sections-'));
  tmpDataDir = path.join(tmpRoot, 'chat-arch-data');
  await cp(FIXTURE_ROOT, tmpDataDir, { recursive: true });
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  await rm(path.dirname(tmpDataDir), { recursive: true, force: true });
});

async function readJson<T>(p: string): Promise<T> {
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

describe('runSemanticAnalysis brief — Phase γ + Wave 2 #4 inputs', () => {
  it('renders Surprises + Project momentum sections when sidecars are non-empty', async () => {
    const now = 1_700_000_010_000;
    const manifest = await readJson<SessionManifest>(
      path.join(tmpDataDir, 'manifest.json'),
    );

    await runAnalysis(manifest, { outDir: tmpDataDir, now });

    // runAnalysis writes its own (likely empty) surprises.json +
    // project-trajectories.json from the single-session fixture's
    // inputs. Overwrite both with rich content so the downstream brief
    // writer has something to render — this is exactly what would land
    // on disk in a real corpus after a productive week.
    await writeFile(
      path.join(tmpDataDir, 'analysis', 'surprises.json'),
      JSON.stringify({
        version: 1,
        generatedAt: now,
        surprises: [
          {
            id: 'streak-1',
            kind: 'streak',
            tone: 'positive',
            summary: 'You shipped 8 PRs in 7 days — a personal best.',
            evidence: { sessionIds: ['s-1'] },
            score: 0.9,
            generatedAt: now,
          },
          {
            id: 'debt-1',
            kind: 'debt-spinning',
            tone: 'concerning',
            summary: 'Pattern "x" keeps recurring across 3 projects.',
            evidence: {},
            score: 0.85,
            generatedAt: now,
          },
        ],
        thresholds: {
          streakMin: 5,
          itsQValueMax: 0.1,
          itsDeltaMin: 0.15,
          reflexiveDeltaMin: 0.15,
          reflexiveEValueMin: 1.2,
          decisionGoodFollowupsMin: 3,
          debtSpinningTopK: 3,
          debtSpinningMinClusterSize: 5,
        },
      }) + '\n',
      'utf8',
    );
    await writeFile(
      path.join(tmpDataDir, 'analysis', 'project-trajectories.json'),
      JSON.stringify({
        projects: [
          {
            projectId: 'example-project',
            projectName: 'example-project',
            classification: 'accelerating',
            slope: 0.42,
            totalSessions: 12,
          },
          {
            projectId: 'beta',
            projectName: 'beta',
            classification: 'flat',
            slope: 0.01,
            totalSessions: 5,
          },
        ],
      }) + '\n',
      'utf8',
    );

    await runSemanticAnalysis({ outDir: tmpDataDir, manifest, now });

    const briefDate = new Date(now).toISOString().slice(0, 10);
    const brief = await readFile(
      path.join(tmpDataDir, 'analysis', 'briefs', `${briefDate}.md`),
      'utf8',
    );

    expect(brief).toContain('► Surprises: 1 positive, 1 concerning.');
    expect(brief).toContain('The standout positive: You shipped 8 PRs');
    expect(brief).toContain('Worth attention: Pattern "x" keeps recurring');
    expect(brief).toContain('► Project momentum:');
    expect(brief).toContain('1 accelerating');
    expect(brief).toContain('1 flat');
  }, 60_000);

  it('failure path: missing sidecars produce a brief WITHOUT the section headers and WITHOUT throwing', async () => {
    // Per CLAUDE.md "Include failure paths for every success path
    // tested." If a regression made any of the new wire-ups throw
    // instead of skip on null, the auto-brief would fail outright.
    // This case exercises the null-tolerance contract: run the
    // pipeline against a fixture where the load-bearing sidecars
    // are EXPLICITLY absent (renamed-aside) and verify the brief
    // still produces, just without the optional sections.
    const now = 1_700_000_010_000;
    const manifest = await readJson<SessionManifest>(
      path.join(tmpDataDir, 'manifest.json'),
    );

    await runAnalysis(manifest, { outDir: tmpDataDir, now });

    // runAnalysis writes empty surprises.json + project-trajectories.json
    // from the single-session fixture. To exercise the FULLY-MISSING
    // path, delete those sidecars before the brief writer runs.
    await rm(path.join(tmpDataDir, 'analysis', 'surprises.json'), {
      force: true,
    });
    await rm(path.join(tmpDataDir, 'analysis', 'project-trajectories.json'), {
      force: true,
    });

    // Must not throw. The brief writer's null-tolerance is the
    // load-bearing contract.
    await runSemanticAnalysis({ outDir: tmpDataDir, manifest, now });

    const briefDate = new Date(now).toISOString().slice(0, 10);
    const brief = await readFile(
      path.join(tmpDataDir, 'analysis', 'briefs', `${briefDate}.md`),
      'utf8',
    );

    // The section headers SHOULD NOT appear when the corresponding
    // input is null. (Note: "Shipped this week" is git-driven and
    // intentionally not asserted — it can fire from the host repo's
    // recent commits regardless of fixture content.)
    expect(brief).not.toContain('► Surprises:');
    expect(brief).not.toContain('► Project momentum:');
  }, 60_000);
});
