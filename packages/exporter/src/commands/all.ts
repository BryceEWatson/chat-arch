import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import type { UnifiedSessionEntry } from '@chat-arch/schema';
import { runCoworkExport } from '../sources/cowork.js';
import { runCliExport } from '../sources/cli.js';
import { runCloudExport } from '../sources/cloud.js';
import { mergeSources } from '../merge.js';
import { runAnalysis } from '../analysis/index.js';
import { runSemanticAnalysis } from '../analysis/semanticAnalysis.js';
import { runEmbed } from '../embeddings/index.js';
import { findRepoRoot } from '../lib/repo-root.js';
import { validateEntries } from '../lib/validate-entry.js';
import { logger } from '../lib/logger.js';
import { discoverWslCliProjectsRoots } from '../lib/wsl.js';

/**
 * Read the cloud-manifest.json written by a previous `cloud` phase.
 * Used by `--no-cloud` mode so the merged output preserves the user's
 * last uploaded-ZIP data even when the rescan skips the cloud phase.
 *
 * Returns `[]` when the file is absent or unreadable — a fresh repo
 * with no cloud data yet is a legitimate state, not an error.
 */
async function readExistingCloudEntries(outDir: string): Promise<readonly UnifiedSessionEntry[]> {
  const p = path.join(outDir, 'cloud-manifest.json');
  try {
    const raw = await readFile(p, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as UnifiedSessionEntry[];
  } catch {
    return [];
  }
}

export async function runAllSubcommand(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      out: { type: 'string', short: 'o' },
      zip: { type: 'string' },
      'no-cloud': { type: 'boolean' },
      'no-auto-label-threshold': { type: 'boolean' },
      // Opt the PR-land network join into the analysis pipeline. Off
      // by default so headless / no-network runs stay clean; the rescan
      // endpoint flips this on when it detects `gh auth status` exit 0.
      // See `runAnalysis()`'s `enablePrJoin` option.
      'enable-pr-join': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    logger.info(
      'chat-arch all [--zip <path>] [--no-cloud] [--no-auto-label-threshold] [--out <dir>]\n\n' +
        '  Run cowork + cli + cloud phases sequentially and merge their output\n' +
        '  into a single unified manifest.json.\n\n' +
        '  --zip                       Cloud-export ZIP path (default: latest match in ~/Downloads).\n' +
        '  --no-cloud                  Skip the cloud phase entirely; keep any previously-written\n' +
        '                              cloud-manifest.json in the merge. Used by the viewer\n' +
        '                              "RESCAN" button — cloud data is only refreshed when the\n' +
        '                              user uploads a ZIP, not as part of rescanning local disks.\n' +
        '  --enable-pr-join            Opt into the gh-API PR-land join after the merge step.\n' +
        '                              Off by default so no-network runs stay clean. The\n' +
        '                              viewer\'s RESCAN button auto-enables this when it\n' +
        '                              detects an authenticated gh CLI.\n' +
        '  --no-auto-label-threshold   Skip the post-semantic threshold-labels auto-fill stage.\n' +
        '                              By default we run scripts/auto-label-threshold.mjs to top up\n' +
        '                              chat-arch-data/labels/threshold-pairs.json using dual-judge\n' +
        '                              `claude -p` headless calls — inherits your Claude Code\n' +
        '                              auth, counts against your plan (no per-token spend).\n' +
        '                              If `claude` isn\'t on PATH the stage logs a single line\n' +
        '                              and skips. Also disabled by CHAT_ARCH_AUTO_LABEL=0\n' +
        '                              (which the viewer\'s "RESCAN" inherits for free since it\n' +
        '                              passes process.env through).\n' +
        '  --out, -o                   Output directory\n' +
        '                              (default: <repo-root>/apps/standalone/public/chat-arch-data).\n',
    );
    return 0;
  }

  const noCloud = values['no-cloud'] === true;
  if (noCloud && values.zip !== undefined) {
    logger.error('`--no-cloud` and `--zip` are mutually exclusive.');
    return 2;
  }

  const outDir = values.out
    ? path.resolve(values.out)
    : path.join(findRepoRoot(), 'apps/standalone/public/chat-arch-data');

  const totalStarted = Date.now();
  logger.info(`all → ${outDir}`);

  // ---- Phase 2: cowork ----
  logger.info('  [1/3] cowork: scanning…');
  const coworkStart = Date.now();
  let coworkResult;
  try {
    coworkResult = await runCoworkExport({ outDir });
  } catch (err) {
    logger.error(`cowork phase failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const coworkMs = Date.now() - coworkStart;
  const coworkReused = coworkResult.reuseCounts.cowork;
  const coworkRescanned = coworkResult.counts.cowork - coworkReused;
  const cliDesktopReused = coworkResult.reuseCounts['cli-desktop'];
  const cliDesktopRescanned = coworkResult.counts['cli-desktop'] - cliDesktopReused;
  logger.info(
    `  [1/3] cowork: cowork=${coworkResult.counts.cowork} (${coworkReused} reused, ${coworkRescanned} rescanned) ` +
      `cli-desktop=${coworkResult.counts['cli-desktop']} (${cliDesktopReused} reused, ${cliDesktopRescanned} rescanned) in ${coworkMs} ms`,
  );

  // ---- Phase 3: cli ----
  logger.info('  [2/3] cli: scanning…');
  const cliStart = Date.now();
  // Discover WSL CLI projects roots on Windows (no-op elsewhere). Failures
  // are warn-once'd internally; we don't fail the whole rescan if WSL is
  // unreachable.
  const wslRoots = await discoverWslCliProjectsRoots();
  if (wslRoots.length > 0) {
    logger.info(`  [2/3] cli: + ${wslRoots.length} WSL root(s)`);
  }
  let cliResult;
  try {
    cliResult = await runCliExport({
      outDir,
      ...(wslRoots.length > 0 ? { additionalProjectsRoots: wslRoots } : {}),
    });
  } catch (err) {
    logger.error(`cli phase failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const cliMs = Date.now() - cliStart;
  const cliDirectReused = cliResult.reuseCounts['cli-direct'];
  const cliDirectRescanned = cliResult.counts['cli-direct'] - cliDirectReused;
  const cliDeskReused = cliResult.reuseCounts['cli-desktop'];
  const cliDeskRescanned = cliResult.counts['cli-desktop'] - cliDeskReused;
  logger.info(
    `  [2/3] cli: cli-direct=${cliResult.counts['cli-direct']} (${cliDirectReused} reused, ${cliDirectRescanned} rescanned) ` +
      `cli-desktop=${cliResult.counts['cli-desktop']} (${cliDeskReused} reused, ${cliDeskRescanned} rescanned) ` +
      `pruned=${cliResult.prunedCount} in ${cliMs} ms`,
  );

  // ---- Phase 4: cloud ----
  // Cloud is a manual-upload model: a new cloud export only exists on
  // disk when the user drops a fresh ZIP in ~/Downloads. `--no-cloud`
  // mode skips this phase entirely and reads the existing cloud-
  // manifest.json from the last successful cloud run, so the user's
  // previously-uploaded cloud data stays in the merged manifest.
  let cloudEntries: readonly UnifiedSessionEntry[];
  if (noCloud) {
    cloudEntries = await readExistingCloudEntries(outDir);
    logger.info(
      `  [3/3] cloud: skipped (no-cloud mode; preserved ${cloudEntries.length} entries from previous cloud-manifest.json)`,
    );
  } else {
    logger.info('  [3/3] cloud: scanning…');
    const cloudStart = Date.now();
    let cloudResult;
    try {
      cloudResult = await runCloudExport({
        outDir,
        ...(values.zip !== undefined ? { zipPath: values.zip } : {}),
      });
    } catch (err) {
      logger.error(`cloud phase failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    const cloudMs = Date.now() - cloudStart;
    logger.info(
      `  [3/3] cloud: cloud=${cloudResult.counts.cloud} (zip=${cloudResult.zipPath}) in ${cloudMs} ms`,
    );
    cloudEntries = cloudResult.entries;
  }

  // ---- Merge ----
  const merged = mergeSources(coworkResult.entries, cliResult.entries, cloudEntries);

  const manifestAbs = path.join(outDir, 'manifest.json');
  await writeFile(manifestAbs, JSON.stringify(merged, null, 2) + '\n', 'utf8');

  const totalMs = Date.now() - totalStarted;
  logger.info(
    `all complete in ${totalMs} ms — merged=${merged.sessions.length} ` +
      `(cowork=${merged.counts.cowork} cli-direct=${merged.counts['cli-direct']} cli-desktop=${merged.counts['cli-desktop']} cloud=${merged.counts.cloud}) → ${manifestAbs}`,
  );

  // Post-merge shape validation.
  const errors = validateEntries(merged.sessions);
  if (errors.length > 0) {
    logger.error(`validateEntries() produced ${errors.length} errors on merged manifest:`);
    for (const e of errors.slice(0, 50)) {
      logger.error(`  [entry ${e.entryIndex} id=${e.entryId}] field=${e.field}: ${e.problem}`);
    }
    if (errors.length > 50) {
      logger.error(`  ... (${errors.length - 50} more)`);
    }
    return 1;
  }

  // Phase 6: run browser-tier analysis writers (Decision 1).
  const enablePrJoin = values['enable-pr-join'] === true;
  try {
    const analysisStart = Date.now();
    const result = await runAnalysis(merged, { outDir, enablePrJoin });
    logger.info(
      `analysis complete in ${Date.now() - analysisStart} ms — dup_clusters=${result.counts.duplicatesClusters} dup_sessions=${result.counts.duplicatesSessions} active=${result.counts.active} dormant=${result.counts.dormant} zombie=${result.counts.zombie} → ${result.analysisDir}`,
    );
  } catch (err) {
    logger.error(
      `analysis phase failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    return 1;
  }

  // Phase 6+: embedding pass (v2 §4). Fail-soft — a missing Ollama
  // service must NOT fail the whole rescan. The driver logs its own
  // skip line + warn; we only translate unexpected throws to a single
  // warn line so the user can still inspect manifest.json after.
  try {
    const embedStart = Date.now();
    const embedResult = await runEmbed({
      outDir,
      manifest: merged,
      onlyChanged: true,
    });
    if (embedResult.skippedReason === undefined) {
      logger.info(
        `embeddings complete in ${Date.now() - embedStart} ms — ` +
          `embedded=${embedResult.embedded} reused=${embedResult.reused} skipped=${embedResult.skipped}`,
      );
    }
  } catch (err) {
    logger.warn(
      `embeddings phase soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Wave 2: semantic analysis layer (discovery scores, F.1 claims,
  // semantic dedup, local topics, upgrade outcomes). Rewrites the
  // manifest in place to populate discoveryScore on every eligible
  // entry. Fail-soft so a missing transcript or partial embedding
  // sidecar doesn't poison the run.
  try {
    const semStart = Date.now();
    const semResult = await runSemanticAnalysis({ outDir, manifest: merged });
    logger.info(
      `semantic-analysis complete in ${Date.now() - semStart} ms — ` +
        `discovery_scored=${semResult.counts.discoveryScored} ` +
        `discovery_high=${semResult.counts.discoveryHighScored} ` +
        `sem_dup_clusters=${semResult.counts.semanticDupClusters} ` +
        `local_topics=${semResult.counts.topicsLocal} ` +
        `audit_claims=${semResult.counts.auditClaims} ` +
        `audit_pass=${semResult.counts.auditPass} ` +
        `audit_fail=${semResult.counts.auditFail} ` +
        `upgrade_outcomes=${semResult.counts.upgradeOutcomes} ` +
        `blog_candidates=${semResult.counts.blogCandidates} ` +
        `embeddings_avail=${semResult.embeddingsAvailable}`,
    );
  } catch (err) {
    logger.warn(
      `semantic-analysis soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Wave 3: threshold-pair auto-labeling. On by default — the script
  // uses `claude -p`, which inherits the user's Claude Code subscription
  // (counts against their plan, no per-token spend). If `claude` isn't
  // available the script probes for it up-front and exits 0 cleanly
  // with a single-line log, so this stage doesn't break scans on
  // machines without Claude Code. Disable explicitly with
  // `--no-auto-label-threshold` or `CHAT_ARCH_AUTO_LABEL=0` (the
  // viewer's RESCAN inherits the env-var path because /api/rescan
  // passes process.env through).
  const autoLabelDisabled =
    values['no-auto-label-threshold'] === true ||
    process.env.CHAT_ARCH_AUTO_LABEL === '0';
  if (!autoLabelDisabled) {
    const scriptPath = path.join(findRepoRoot(), 'scripts', 'auto-label-threshold.mjs');
    const alStart = Date.now();
    try {
      const code = await runChild('node', [scriptPath, '--data-dir', outDir]);
      if (code === 0) {
        logger.info(`auto-label-threshold complete in ${Date.now() - alStart} ms`);
      } else {
        logger.warn(
          `auto-label-threshold exited ${code} after ${Date.now() - alStart} ms (continuing)`,
        );
      }
    } catch (err) {
      logger.warn(
        `auto-label-threshold soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Wave 4: fit isotonic calibration from the (possibly just-updated)
  // threshold labels. Pure local PAV, no network or auth. Skips
  // silently when labels can't support a non-degenerate fit. The
  // calibration applies starting from the NEXT scan's semantic-dedup
  // pass — this scan's dedup output reflects the pre-fit state.
  // Same-scan re-dedup is a future PR; deferred because the calibration
  // surface is read by both the exporter and the viewer, so the file-
  // on-disk model has to land first regardless.
  const fitScriptPath = path.join(findRepoRoot(), 'scripts', 'fit-calibration.mjs');
  const fitStart = Date.now();
  try {
    const code = await runChild('node', [fitScriptPath, '--data-dir', outDir]);
    if (code === 0) {
      logger.info(`fit-calibration complete in ${Date.now() - fitStart} ms`);
    } else {
      logger.warn(
        `fit-calibration exited ${code} after ${Date.now() - fitStart} ms (continuing)`,
      );
    }
  } catch (err) {
    logger.warn(
      `fit-calibration soft-failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return 0;
}

// Streams the child's stdout/stderr through this process so the user
// sees per-pair progress live (the viewer's RESCAN already pipes the
// exporter's stdio to its NDJSON event stream, so this also surfaces
// in the web UI). Resolves with the exit code.
function runChild(cmd: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
}
