import { unzipSync, strFromU8 } from 'fflate';
import type { CloudConversation, CloudMemories, CloudProject, CloudUser } from '@chat-arch/schema';
import { buildCloudEntries, type CloudSourceData } from '@chat-arch/exporter/cloud-mapping';
import type { UploadedCloudData } from '../types.js';

const CONVERSATIONS_JSON = 'conversations.json';
const PROJECTS_JSON = 'projects.json';
const USERS_JSON = 'users.json';
const MEMORIES_JSON = 'memories.json';

/**
 * Parse a Settings→Privacy cloud-export ZIP uploaded by the user and return
 * the in-memory manifest the viewer needs.
 *
 * - Runs entirely in the browser (fflate is pure JS, no WASM, no workers).
 * - Only `conversations.json` is required. Other top-level files are optional.
 * - On any parse error we throw a plain `Error` whose message is suitable
 *   for direct display in the UI.
 */
export async function parseCloudZip(file: File): Promise<UploadedCloudData> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  let files: Record<string, Uint8Array>;
  try {
    // `unzipSync` returns every entry by name (top-level or nested). Settings→
    // Privacy exports put the JSON files at the root with exact filenames,
    // so we pick them by key below.
    files = unzipSync(bytes);
  } catch (err) {
    throw new Error(
      `Could not read ZIP archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!files[CONVERSATIONS_JSON]) {
    throw new Error(
      `This ZIP does not contain ${CONVERSATIONS_JSON} at the root. ` +
        `Upload a Settings → Privacy → Export data ZIP from Claude.ai.`,
    );
  }

  const conversations = parseJsonArray<CloudConversation>(
    files[CONVERSATIONS_JSON],
    CONVERSATIONS_JSON,
  );

  const data: CloudSourceData = { conversations };
  if (files[PROJECTS_JSON]) {
    data.projects = parseJsonArray<CloudProject>(files[PROJECTS_JSON], PROJECTS_JSON);
  }
  if (files[USERS_JSON]) {
    data.users = parseJsonArray<CloudUser>(files[USERS_JSON], USERS_JSON);
  }
  if (files[MEMORIES_JSON]) {
    data.memories = parseJsonArray<CloudMemories>(files[MEMORIES_JSON], MEMORIES_JSON);
  }

  const mapped = buildCloudEntries(data);

  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: Date.now(),
      counts: {
        cloud: mapped.entries.length,
        cowork: 0,
        'cli-direct': 0,
        'cli-desktop': 0,
      },
      sessions: mapped.entries,
    },
    conversationsById: mapped.conversationsById,
    sourceLabel: `${file.name} (${formatBytes(file.size)})`,
  };
}

function parseJsonArray<T>(buf: Uint8Array, filename: string): readonly T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(buf));
  } catch (err) {
    throw new Error(
      `${filename} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${filename} is not a JSON array (got ${typeof parsed}).`);
  }
  return parsed as readonly T[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
