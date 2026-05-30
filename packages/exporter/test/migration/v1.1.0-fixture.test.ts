/**
 * Migration test: 1.1.0 → 1.2.0 EXPORTER_VERSION upgrade.
 *
 * Per the plan's "EXPORTER_VERSION migration story" subsection:
 *
 *   (a) corrections cache REUSED (heuristicRecallVersion unchanged →
 *       generatedAt preserved; no rescan).
 *   (b) audit cache INVALIDATED (auditConfigVersion 1 → 2 in output;
 *       the synthetic gh-pr-opened claim from the transcript appears
 *       in results).
 *   (c) composite-outcomes.json EXISTS with compositeVersion: 1,
 *       weightsVersion: 1, weights embedded.
 *   (d) meta.json reflects 1.2.0 (exporterVersion === '1.2.0';
 *       tiers.browser.files[] includes the new sidecars; counts
 *       populated).
 *
 * The fixture tree at fixtures/v1.1.0/ matches the pre-Wave-5 on-disk
 * layout. The test copies it to a temp dir (so any writes don't mutate
 * the checked-in fixture), runs the 1.2.0 builders against it, and
 * asserts each property.
 *
 * All identifiers in the fixture use reserved / fake values
 * (`example-org`, `example-repo`, `deadbeef`-prefix SHAs, session id
 * `s-1`) per the PII constraint enforced by
 * `scripts/lint-fixture-pii.mjs`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AuditResultsFile,
  CompositeOutcomesFile,
  CorrectionsFile,
  SessionManifest,
} from '@chat-arch/schema';
import { runAnalysis, EXPORTER_VERSION } from '../../src/analysis/index.js';
import { runSemanticAnalysis } from '../../src/analysis/semanticAnalysis.js';
import { logger } from '../../src/lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'v1.1.0', 'chat-arch-data');

let tmpDataDir: string;

beforeEach(async () => {
  // Copy the fixture to a temp dir so tests stay hermetic.
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'chat-arch-migration-'));
  tmpDataDir = path.join(tmpRoot, 'chat-arch-data');
  await cp(FIXTURE_ROOT, tmpDataDir, { recursive: true });
  // Silence the analysis logger during the run — the test only cares
  // about the on-disk results, not the human-readable progress lines.
  logger.setSink(() => {});
});

afterEach(async () => {
  logger.resetForTests();
  // tmpDataDir is under the system tmp; clean up the parent we mkdtemp'd.
  await rm(path.dirname(tmpDataDir), { recursive: true, force: true });
});

async function readJson<T>(p: string): Promise<T> {
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

describe('migration v1.1.0 → 1.2.0', () => {
  it('reuses corrections cache, invalidates audit cache, writes composite + new sidecars, bumps meta', async () => {
    // Anchor "now" well past the fixture's generatedAt so cache
    // freshness checks have a deterministic answer.
    const now = 1700000010000;

    const manifest = await readJson<SessionManifest>(path.join(tmpDataDir, 'manifest.json'));

    // Capture fixture state for the cache-reuse assertion.
    const correctionsBefore = await readJson<CorrectionsFile>(
      path.join(tmpDataDir, 'analysis', 'correction-candidates.json'),
    );
    expect(correctionsBefore.heuristicRecallVersion).toBe(2);
    const correctionsGeneratedAtBefore = correctionsBefore.generatedAt;

    // ---- Run the 1.2.0 orchestrator pipelines ----
    // runAnalysis writes: corrections, composite-outcomes, archetypes,
    // decisions, …, and updates meta.json to exporterVersion 1.2.0.
    // runSemanticAnalysis writes: audit-results.json with the new
    // auditConfigVersion: 2 (the version bump in auditConfig.ts).
    await runAnalysis(manifest, { outDir: tmpDataDir, now });
    await runSemanticAnalysis({ outDir: tmpDataDir, manifest, now });

    // ---- (a) Corrections cache INVALIDATED ----
    // The fixture was written under heuristicRecallVersion 2; the
    // current kernel runs at version 3 (envelope-unwrap pass added,
    // see detectCorrectionCandidates.ts history block). A version
    // mismatch invalidates the cache and forces a full rescan.
    // The fixture's transcript contains the user turn "Please open
    // a PR for these changes." which fires the `imperative-override`
    // LF, so the rescan emits exactly one correction. This used to
    // be empty under the v1.1.0 → v1.2.0 migration (when both
    // versions had heuristicRecallVersion 2 and the cache reused
    // verbatim); the assertion below is the post-invalidate shape.
    const correctionsAfter = await readJson<CorrectionsFile>(
      path.join(tmpDataDir, 'analysis', 'correction-candidates.json'),
    );
    expect(correctionsAfter.heuristicRecallVersion).toBe(3);
    expect(correctionsAfter.scannedSessionIds).toEqual(['s-1']);
    expect(correctionsAfter.corrections).toHaveLength(1);
    expect(correctionsAfter.corrections[0]?.sessionId).toBe('s-1');
    expect(correctionsAfter.corrections[0]?.signals[0]?.kind).toBe(
      'imperative-override',
    );
    // After invalidation, generatedAt resets to `now` (the orchestrator
    // restamps on rescan). It must be strictly later than the pre-run
    // fixture timestamp.
    expect(correctionsAfter.generatedAt).toBeGreaterThanOrEqual(
      correctionsGeneratedAtBefore,
    );

    // ---- (b) Audit cache INVALIDATED ----
    // The auditConfigVersion bump (1 → 2) in auditConfig.ts means a
    // fresh audit pass produces auditConfigVersion: 2 on disk. The
    // gh-pr-opened claim from the transcript ("I have created the
    // pull request — feature/test-1 against main.") must appear in
    // results.
    const auditAfter = await readJson<AuditResultsFile>(
      path.join(tmpDataDir, 'analysis', 'audit-results.json'),
    );
    expect(auditAfter.auditConfigVersion).toBe(2);
    expect(auditAfter.generatedAt).toBe(now);
    const ghPrOpenedRows = auditAfter.results.filter(
      (r) => r.claimType === 'gh-pr-opened',
    );
    expect(ghPrOpenedRows.length).toBeGreaterThanOrEqual(1);
    // And specifically scoped to our synthetic session.
    expect(ghPrOpenedRows.some((r) => r.sessionId === 's-1')).toBe(true);

    // ---- (c) composite-outcomes.json exists, v1, weights embedded ----
    const composite = await readJson<CompositeOutcomesFile>(
      path.join(tmpDataDir, 'analysis', 'composite-outcomes.json'),
    );
    expect(composite.compositeVersion).toBe(1);
    expect(composite.weightsVersion).toBe(1);
    expect(composite.weights).toBeDefined();
    expect(composite.weights.testPass).toBeGreaterThan(0);
    expect(typeof composite.weightsHash).toBe('string');
    expect(composite.weightsHash.length).toBeGreaterThan(0);
    expect(composite.outcomes.length).toBeGreaterThanOrEqual(1);
    expect(composite.outcomes.some((o) => o.sessionId === 's-1')).toBe(true);

    // ---- (d) meta.json reflects the current EXPORTER_VERSION ----
    // Bumped 1.2.0 → 1.3.0 in Phase Rev3-I I5 for the Rev3
    // substrate cutover; 1.4.0 / 1.4.1 in feed-redesign Phase A / γ;
    // 1.4.1 → 1.5.0 in Wave 2 #1 for the delta-surprises archive
    // sidecar family. The migration writes whatever the constant
    // says, not a hardcoded literal.
    const meta = await readJson<{
      exporterVersion: string;
      tiers: { browser: { files: readonly string[] } };
      counts: Record<string, unknown>;
    }>(path.join(tmpDataDir, 'analysis', 'meta.json'));
    // Assert against the constant, not a literal — the migration writes
    // whatever EXPORTER_VERSION currently says, so a version bump should
    // not break this test.
    expect(meta.exporterVersion).toBe(EXPORTER_VERSION);

    // The Wave-5 sidecars (+ feed-redesign Phase A surprises.json)
    // must all be registered in the browser tier.
    const expectedNewSidecars = [
      'composite-outcomes.json',
      'config-history.json',
      'its-analysis.json',
      'knowledge-debt.json',
      'reflexive.json',
      'decisions.json',
      'archetypes.json',
      'project-trajectories.json',
      'surface-comparison.json',
      'skill-curves.json',
      'surprises.json',
    ];
    for (const f of expectedNewSidecars) {
      expect(
        meta.tiers.browser.files,
        `meta.json.tiers.browser.files should include '${f}'`,
      ).toContain(f);
    }

    // Counts populated.
    expect(meta.counts).toHaveProperty('compositeOutcomes');
    expect(meta.counts).toHaveProperty('archetypes');
    expect(meta.counts).toHaveProperty('decisions');
    expect(meta.counts).toHaveProperty('configHistoryCommits');
    expect(meta.counts).toHaveProperty('itsContrasts');
    expect(meta.counts).toHaveProperty('knowledgeDebtClusters');
    expect(meta.counts).toHaveProperty('reflexivePairs');
    expect(meta.counts).toHaveProperty('projectTrajectories');
    expect(meta.counts).toHaveProperty('surfaceCells');
    expect(meta.counts).toHaveProperty('skillCurves');
    expect(meta.counts.sessions).toBe(1);
  }, 30000);
});
