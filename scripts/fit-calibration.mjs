#!/usr/bin/env node
/**
 * Fit an isotonic calibration curve from threshold-pair labels.
 *
 * Reads `chat-arch-data/labels/threshold-pairs.json` (produced by the
 * TUI labeler at scripts/label.mjs or the auto-labeler at
 * scripts/auto-label-threshold.mjs). If the labels can support a non-
 * degenerate PAV fit (≥40 labels with both classes present), writes
 * `chat-arch-data/calibration.json` and a hash fingerprint into
 * `chat-arch-data/analysis/meta.json`'s `calibrationFingerprint`
 * field. Otherwise prints the reason and exits 0 (no-op).
 *
 * Idempotent: skips the write when the fitted knots haven't changed
 * vs. the existing calibration.json. The fingerprint in meta.json is
 * what the exporter's incremental cache uses to decide whether dedup
 * needs to re-run; not bumping it on unchanged knots avoids spurious
 * cache invalidation.
 *
 * Usage:
 *   node scripts/fit-calibration.mjs [--data-dir <path>] [--band lo,hi]
 *
 * No API calls, no network, no auth — pure local file I/O over PAV.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fitCalibration } from '@chat-arch/analysis';

function parseArgs(argv) {
  const out = { dataDir: null, band: [0.85, 1.0] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--band') {
      const [lo, hi] = argv[++i].split(',').map(Number);
      out.band = [lo, hi];
    } else if (a === '--help' || a === '-h') {
      process.stderr.write(
        'Usage: node scripts/fit-calibration.mjs [--data-dir <path>] [--band 0.85,1.0]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const dataDir =
    opts.dataDir ?? path.join('apps', 'standalone', 'public', 'chat-arch-data');
  const labelsPath = path.join(dataDir, 'labels', 'threshold-pairs.json');
  const calibrationPath = path.join(dataDir, 'calibration.json');
  const metaPath = path.join(dataDir, 'analysis', 'meta.json');

  const labelsStore = await readJson(labelsPath);
  if (labelsStore === null || typeof labelsStore.labels !== 'object') {
    console.log(`No labels at ${labelsPath} — skipping calibration fit.`);
    return;
  }

  const labels = [];
  for (const v of Object.values(labelsStore.labels)) {
    if (typeof v?.cos === 'number' && typeof v?.nearDup === 'boolean') {
      labels.push({ cos: v.cos, nearDup: v.nearDup });
    }
  }

  const curve = fitCalibration({ labels, band: opts.band });
  if (curve === null) {
    const pos = labels.filter((l) => l.nearDup).length;
    console.log(
      `Cannot fit isotonic calibration: ${labels.length} labels, ${pos} positives. ` +
        `Need ≥40 with at least one of each class. Leaving calibration.json absent ` +
        `(dedup falls back to literature threshold).`,
    );
    return;
  }

  const existing = await readJson(calibrationPath);
  const knotsHash = sha256Hex(JSON.stringify(curve.knots));
  const existingHash = existing?.knots
    ? sha256Hex(JSON.stringify(existing.knots))
    : null;
  if (existingHash === knotsHash) {
    console.log(
      `Calibration unchanged (${curve.labelCount} labels, ${curve.knots.length} knots). ` +
        `Skipping write.`,
    );
    return;
  }

  await mkdir(path.dirname(calibrationPath), { recursive: true });
  await writeFile(calibrationPath, JSON.stringify(curve, null, 2) + '\n', 'utf8');
  console.log(
    `Wrote ${calibrationPath} — ${curve.labelCount} labels → ${curve.knots.length} knots.`,
  );

  // Stamp the fingerprint into analysis/meta.json so the incremental
  // rescan cache key picks up the change (see research/dedup-
  // calibration-design.md "Schema/cache invalidation"). Keep the rest
  // of meta.json untouched.
  const meta = (await readJson(metaPath)) ?? {};
  meta.calibrationFingerprint = knotsHash;
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(
    `Stamped calibrationFingerprint=${knotsHash.slice(0, 12)}… in ${metaPath}.`,
  );

  // Print the curve so the user sees it land. Useful for "did this do
  // anything?" sanity-checks at scan-end.
  console.log('\nKnots (cos → P(near-dup)):');
  for (const k of curve.knots) {
    console.log(`  ${k.cos.toFixed(4)} → ${k.p.toFixed(3)}`);
  }
}

main().catch((err) => {
  console.error(`fit-calibration crashed: ${err.message ?? err}`);
  console.error(err.stack ?? '');
  process.exit(1);
});
