import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CloudConversation, CloudProject, UnifiedSessionEntry } from '@chat-arch/schema';
import { runWithConcurrency } from '../lib/concurrency.js';
import { findLatestExportZip } from '../lib/downloads.js';
import { unzipTo } from '../lib/zip.js';
import { logger } from '../lib/logger.js';
import { buildEntry, compileProjectPatterns } from '@chat-arch/analysis';

const CHUNK_CONCURRENCY = 8;

/**
 * Top-level files we read from the export ZIP. `conversations.json` is the
 * canonical source; `projects.json`, when present, is used to populate
 * `session.project` on cloud entries whose titles name one of the user's
 * claude.ai projects. `users.json` / `memories.json` are still ignored.
 */
const CONVERSATIONS_JSON = 'conversations.json';
const PROJECTS_JSON = 'projects.json';

export interface RunCloudExportOptions {
  outDir: string;
  /** Override — if omitted, auto-detect latest `data-*-batch-*.zip` in Downloads. */
  zipPath?: string;
  /** Override for tests. Defaults to `os.homedir() + /Downloads`. */
  downloadsDir?: string;
}

export interface CloudExportResult {
  entries: UnifiedSessionEntry[];
  counts: { cloud: number };
  /** Absolute path of the ZIP that was unpacked. */
  zipPath: string;
  /** Absolute path of the temp dir used (already cleaned up on return). */
  tempDir: string;
  /** Number of conversations skipped due to unparseable timestamps. */
  conversationsSkipped: number;
}

/**
 * Phase 4 entry. Locate the ZIP, unpack to temp, parse `conversations.json`,
 * emit slim `cloud-manifest.json` + per-conversation chunks, clean up.
 */
export async function runCloudExport(opts: RunCloudExportOptions): Promise<CloudExportResult> {
  const outDir = opts.outDir;
  const downloadsDir = opts.downloadsDir ?? path.join(os.homedir(), 'Downloads');

  const zipPath = opts.zipPath
    ? path.resolve(opts.zipPath)
    : await findLatestExportZip(downloadsDir);

  if (!zipPath) {
    throw new Error(
      `no cloud-export ZIP found in ${downloadsDir}. ` +
        `Expected a file matching data-<uuid>-<ts>-<hash>-batch-NNNN.zip. ` +
        `Pass --zip <path> to override.`,
    );
  }

  // Short temp name keeps us away from Windows MAX_PATH issues.
  const tempDir = path.join(os.tmpdir(), `ca-${randomBytes(4).toString('hex')}`);

  try {
    await unzipTo(zipPath, tempDir);

    const conversationsFile = path.join(tempDir, CONVERSATIONS_JSON);
    let raw: string;
    try {
      raw = await readFile(conversationsFile, 'utf8');
    } catch (err) {
      throw new Error(
        `expected ${CONVERSATIONS_JSON} at the root of ${zipPath}, but ` +
          `could not read ${conversationsFile}: ${(err as Error).message}`,
      );
    }

    let conversations: readonly CloudConversation[];
    try {
      conversations = JSON.parse(raw) as readonly CloudConversation[];
    } catch (err) {
      throw new Error(`${conversationsFile} is not valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(conversations)) {
      throw new Error(
        `${conversationsFile} parsed but is not an array (got ${typeof conversations}).`,
      );
    }

    // Optional projects.json — when present, supplies project names used to
    // label conversations whose titles mention them. Any failure to read or
    // parse is non-fatal: cloud entries simply stay unlabeled, matching the
    // pre-existing behavior for users whose export doesn't include this file.
    let projects: readonly CloudProject[] | undefined;
    const projectsFile = path.join(tempDir, PROJECTS_JSON);
    try {
      const rawProjects = await readFile(projectsFile, 'utf8');
      const parsed = JSON.parse(rawProjects);
      if (Array.isArray(parsed)) projects = parsed as readonly CloudProject[];
    } catch {
      // File absent or malformed — no-op. projects stays undefined.
    }

    const result = await buildCloudOutputs(conversations, outDir, projects);

    return {
      entries: result.entries,
      counts: { cloud: result.entries.length },
      zipPath,
      tempDir,
      conversationsSkipped: result.conversationsSkipped,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch((err) => {
      logger.warn(`could not clean up temp dir ${tempDir}: ${(err as Error).message}`);
    });
  }
}

/**
 * Node-side post-extraction pipeline — map conversations to entries (via the
 * pure `buildEntry`), write per-conversation chunks, write slim manifest.
 *
 * Exposed separately so tests can exercise the post-extraction pipeline
 * without actually constructing a ZIP.
 */
export async function buildCloudOutputs(
  conversations: readonly CloudConversation[],
  outDir: string,
  projects?: readonly CloudProject[],
): Promise<{
  entries: UnifiedSessionEntry[];
  conversationsSkipped: number;
}> {
  await mkdir(path.join(outDir, 'cloud-conversations'), { recursive: true });

  const entries: UnifiedSessionEntry[] = [];
  const unknownSenders = new Set<string>();
  const projectPatterns = compileProjectPatterns(projects);
  let skipped = 0;

  await runWithConcurrency(conversations, CHUNK_CONCURRENCY, async (conv) => {
    const built = buildEntry(conv, projectPatterns);
    if (built === null) {
      logger.warn(
        `cloud conversation ${conv.uuid} has unparseable created_at/updated_at; skipping`,
      );
      skipped += 1;
      return;
    }

    // Track unknown senders for a single aggregated warning. The pure
    // mapping module is silent; we surface it here on the Node side.
    if (Array.isArray(conv.chat_messages)) {
      for (const msg of conv.chat_messages) {
        if (
          typeof msg.sender === 'string' &&
          msg.sender !== 'human' &&
          msg.sender !== 'assistant' &&
          !unknownSenders.has(msg.sender)
        ) {
          unknownSenders.add(msg.sender);
          logger.warnOnce(
            `cloud-unknown-sender:${msg.sender}`,
            `cloud chat_messages contain unknown sender "${msg.sender}" (first seen in ${conv.uuid}); counting toward neither user nor assistant`,
          );
        }
      }
    }

    // Write the per-conversation chunk (full fidelity, compact JSON) and
    // immediately drop the reference — we do NOT retain the full chat_messages
    // array in the in-memory array we return.
    const chunkAbs = path.join(outDir, 'cloud-conversations', `${conv.uuid}.json`);
    await writeFile(chunkAbs, JSON.stringify(conv), 'utf8');

    entries.push(built);
  });

  entries.sort((a, b) => b.updatedAt - a.updatedAt);

  const manifestAbs = path.join(outDir, 'cloud-manifest.json');
  await writeFile(manifestAbs, JSON.stringify(entries, null, 2) + '\n', 'utf8');

  return { entries, conversationsSkipped: skipped };
}

// Re-export the pure `buildEntry` so downstream imports (`sources/cloud.js`)
// continue to work unchanged for consumers that were importing it from here.
export { buildEntry };
