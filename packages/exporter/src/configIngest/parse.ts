import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ConfigDocument,
  ConfigDocumentKind,
  ConfigDocumentSource,
  ConfigSentence,
} from '@chat-arch/schema';
import { sha256Hex } from '@chat-arch/analysis';

function makeId(source: ConfigDocumentSource, absolutePath: string): string {
  return `cfg_${sha256Hex(`${source}:${absolutePath}`).slice(0, 12)}`;
}

interface FrontMatter {
  raw: string[];
  endLine: number;
  fields: Record<string, string>;
}

function extractFrontMatter(lines: string[]): FrontMatter | null {
  if (lines.length === 0 || lines[0]?.trim() !== '---') return null;
  const raw: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') {
      const fields: Record<string, string> = {};
      for (const r of raw) {
        const m = r.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (m && m[1] !== undefined) {
          fields[m[1]] = (m[2] ?? '').trim();
        }
      }
      return { raw, endLine: i + 1, fields };
    }
    raw.push(line);
  }
  return null;
}

function bulletText(line: string): string | null {
  const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
  return m && m[1] !== undefined ? m[1].trim() : null;
}

function headingText(line: string): string | null {
  const m = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
  return m && m[2] !== undefined ? m[2].trim() : null;
}

function parseMarkdown(text: string): {
  sentences: ConfigSentence[];
  frontMatter: FrontMatter | null;
} {
  const lines = text.split(/\r?\n/);
  const sentences: ConfigSentence[] = [];
  let idx = 0;

  const fm = extractFrontMatter(lines);
  let cursor = 0;
  if (fm) {
    for (let i = 0; i < fm.raw.length; i++) {
      const r = fm.raw[i] ?? '';
      const trimmed = r.trim();
      if (trimmed === '') continue;
      const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      const sentenceText = m && m[1] !== undefined ? `${m[1]}: ${(m[2] ?? '').trim()}` : trimmed;
      const lineNo = i + 2;
      sentences.push({
        index: idx++,
        text: sentenceText,
        kind: 'frontmatter',
        lineRange: { start: lineNo, end: lineNo },
      });
    }
    cursor = fm.endLine;
  }

  let inFence = false;
  let paraBuf: string[] = [];
  let paraStart = 0;

  const flushPara = (endLine: number): void => {
    if (paraBuf.length === 0) return;
    const joined = paraBuf.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length > 0) {
      sentences.push({
        index: idx++,
        text: joined,
        kind: 'paragraph',
        lineRange: { start: paraStart, end: endLine },
      });
    }
    paraBuf = [];
  };

  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const trimmed = line.trim();

    if (/^\s*```/.test(line)) {
      flushPara(lineNo - 1);
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (trimmed === '') {
      flushPara(lineNo - 1);
      continue;
    }

    const heading = headingText(line);
    if (heading !== null) {
      flushPara(lineNo - 1);
      sentences.push({
        index: idx++,
        text: heading,
        kind: 'heading',
        lineRange: { start: lineNo, end: lineNo },
      });
      continue;
    }

    const bullet = bulletText(line);
    if (bullet !== null) {
      flushPara(lineNo - 1);
      sentences.push({
        index: idx++,
        text: bullet,
        kind: 'bullet',
        lineRange: { start: lineNo, end: lineNo },
      });
      continue;
    }

    if (paraBuf.length === 0) paraStart = lineNo;
    paraBuf.push(trimmed);
  }
  flushPara(lines.length);

  return { sentences, frontMatter: fm };
}

interface JsonValue {
  [k: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function collectHookCommands(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectHookCommands(item, out);
    return;
  }
  if (!isRecord(node)) return;
  if (typeof node['command'] === 'string' && node['command'].trim() !== '') {
    out.push(node['command']);
  }
  for (const v of Object.values(node)) {
    collectHookCommands(v, out);
  }
}

function parseSettings(text: string): ConfigSentence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const sentences: ConfigSentence[] = [];
  let idx = 0;

  if (isRecord(parsed) && isRecord(parsed['permissions'])) {
    const perms = parsed['permissions'] as JsonValue;
    const allow = perms['allow'];
    if (Array.isArray(allow)) {
      for (const p of allow) {
        if (typeof p === 'string') {
          sentences.push({
            index: idx++,
            text: `allow: ${p}`,
            kind: 'permission',
            lineRange: { start: 1, end: 1 },
          });
        }
      }
    }
    const deny = perms['deny'];
    if (Array.isArray(deny)) {
      for (const p of deny) {
        if (typeof p === 'string') {
          sentences.push({
            index: idx++,
            text: `deny: ${p}`,
            kind: 'permission',
            lineRange: { start: 1, end: 1 },
          });
        }
      }
    }
  }

  if (isRecord(parsed) && parsed['hooks'] !== undefined) {
    const cmds: string[] = [];
    collectHookCommands(parsed['hooks'], cmds);
    for (const c of cmds) {
      sentences.push({
        index: idx++,
        text: c,
        kind: 'hook-command',
        lineRange: { start: 1, end: 1 },
      });
    }
  }

  return sentences;
}

function defaultTitle(
  kind: ConfigDocumentKind,
  absolutePath: string,
  source: ConfigDocumentSource,
  projectRoot: string | undefined,
): string {
  switch (kind) {
    case 'claude-md':
      return source === 'global'
        ? 'Global CLAUDE.md'
        : `${path.basename(projectRoot ?? path.dirname(absolutePath))} CLAUDE.md`;
    case 'settings':
      return source === 'global'
        ? 'Global settings'
        : `${path.basename(projectRoot ?? path.dirname(path.dirname(absolutePath)))} settings`;
    case 'skill': {
      const dir = path.basename(path.dirname(absolutePath));
      return dir;
    }
    case 'agent':
    case 'command':
      return path.basename(absolutePath, path.extname(absolutePath));
  }
}

export async function parseConfigDocument(
  absolutePath: string,
  source: ConfigDocumentSource,
  kind: ConfigDocumentKind,
  projectRoot?: string,
): Promise<ConfigDocument> {
  const text = await readFile(absolutePath, 'utf8');
  let sentences: ConfigSentence[];
  let title = defaultTitle(kind, absolutePath, source, projectRoot);

  if (kind === 'settings') {
    sentences = parseSettings(text);
  } else {
    const parsed = parseMarkdown(text);
    sentences = parsed.sentences;
    if (kind === 'skill' && parsed.frontMatter) {
      const name = parsed.frontMatter.fields['name'];
      if (name && name.length > 0) title = name;
    }
  }

  const id = makeId(source, absolutePath);
  return {
    id,
    source,
    kind,
    absolutePath,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    title,
    sentences,
  };
}
