#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ConfigsFile } from '@chat-arch/schema';
import { ingestConfigs } from '../configIngest/index.js';

interface ParsedArgs {
  globalRoot: string;
  projectRootsFile?: string;
  output: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let globalRoot: string | undefined;
  let projectRootsFile: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--global-root' && next !== undefined) {
      globalRoot = next;
      i++;
    } else if (a === '--project-roots-file' && next !== undefined) {
      projectRootsFile = next;
      i++;
    } else if (a === '--output' && next !== undefined) {
      output = next;
      i++;
    }
  }

  if (output === undefined) {
    throw new Error('--output <path> is required');
  }
  if (globalRoot === undefined) {
    globalRoot = path.join(os.homedir(), '.claude');
  }
  return {
    globalRoot,
    output,
    ...(projectRootsFile !== undefined ? { projectRootsFile } : {}),
  };
}

async function loadProjectRoots(file: string | undefined): Promise<string[]> {
  if (file === undefined) return [];
  const text = await readFile(file, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
    throw new Error(`--project-roots-file must contain a JSON array of strings (${file})`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectRoots = await loadProjectRoots(args.projectRootsFile);
  const documents = await ingestConfigs({
    globalRoot: args.globalRoot,
    projectRoots,
  });
  const out: ConfigsFile = {
    generatedAt: Date.now(),
    documents,
  };
  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, JSON.stringify(out, null, 2), 'utf8');
  process.stderr.write(
    `[ingest-configs] wrote ${documents.length} config documents to ${args.output}\n`,
  );
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ingest-configs-cli: ${msg}\n`);
    process.exit(1);
  });
}
