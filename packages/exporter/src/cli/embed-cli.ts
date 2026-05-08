#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { embed, DEFAULT_EMBEDDING_MODEL } from '../embeddings/index.js';

interface ParsedArgs {
  input?: string;
  output?: string;
  model?: string;
  baseUrl?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (next === undefined) break;
    if (arg === '--input') {
      out.input = next;
      i++;
    } else if (arg === '--output') {
      out.output = next;
      i++;
    } else if (arg === '--model') {
      out.model = next;
      i++;
    } else if (arg === '--base-url') {
      out.baseUrl = next;
      i++;
    }
  }
  return out;
}

const USAGE = `\
embed-cli --input <path> --output <path> [--model <name>] [--base-url <url>]

Reads { texts: string[] } from <input>, writes
{ vectors: number[][], model: string, dimensions: number } to <output>.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const raw = await readFile(args.input, 'utf8');
  const parsed = JSON.parse(raw) as { texts?: unknown };
  if (!Array.isArray(parsed.texts) || !parsed.texts.every((t) => typeof t === 'string')) {
    throw new Error('Input JSON must have { texts: string[] }');
  }
  const texts = parsed.texts as string[];

  const model = args.model ?? DEFAULT_EMBEDDING_MODEL;
  const embedOpts: { model: string; baseUrl?: string } = { model };
  if (args.baseUrl !== undefined) embedOpts.baseUrl = args.baseUrl;

  const vectors = await embed(texts, embedOpts);
  const dimensions = vectors[0]?.length ?? 0;
  const serializable = vectors.map((v) => Array.from(v));

  await writeFile(
    args.output,
    JSON.stringify({ vectors: serializable, model, dimensions }, null, 2) + '\n',
    'utf8',
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`embed-cli: ${msg}\n`);
  process.exit(1);
});
