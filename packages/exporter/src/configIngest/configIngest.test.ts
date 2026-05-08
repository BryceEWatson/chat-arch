import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ingestConfigs } from './index.js';

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

describe('ingestConfigs', () => {
  it('discovers and parses a full global root', async () => {
    const globalRoot = await makeTmp('cfg-global-');
    await writeFile(
      path.join(globalRoot, 'CLAUDE.md'),
      '# Heading\n\n- a bullet rule\n\nA paragraph line\nthat continues.\n',
    );

    await mkdir(path.join(globalRoot, 'skills', 'demo'), { recursive: true });
    await writeFile(
      path.join(globalRoot, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: a thing\n---\n# Title\n- step one\n',
    );

    await mkdir(path.join(globalRoot, 'agents'), { recursive: true });
    await writeFile(
      path.join(globalRoot, 'agents', 'reviewer.md'),
      '# Reviewer\n- check code\n',
    );

    await mkdir(path.join(globalRoot, 'commands'), { recursive: true });
    await writeFile(
      path.join(globalRoot, 'commands', 'ship.md'),
      '# Ship\n- run tests\n',
    );

    await writeFile(
      path.join(globalRoot, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm)'] },
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'echo done' }] },
          ],
        },
      }),
    );

    const docs = await ingestConfigs({ globalRoot, projectRoots: [] });

    const byKind = (k: string): typeof docs => docs.filter((d) => d.kind === k);
    expect(byKind('claude-md')).toHaveLength(1);
    expect(byKind('skill')).toHaveLength(1);
    expect(byKind('agent')).toHaveLength(1);
    expect(byKind('command')).toHaveLength(1);
    expect(byKind('settings')).toHaveLength(1);

    const skill = byKind('skill')[0]!;
    expect(skill.title).toBe('demo-skill');
    expect(skill.sentences.some((s) => s.kind === 'frontmatter')).toBe(true);

    const claudeMd = byKind('claude-md')[0]!;
    expect(claudeMd.title).toBe('Global CLAUDE.md');
    expect(claudeMd.sentences.some((s) => s.kind === 'heading')).toBe(true);
    expect(claudeMd.sentences.some((s) => s.kind === 'bullet')).toBe(true);
    expect(claudeMd.sentences.some((s) => s.kind === 'paragraph')).toBe(true);

    const settings = byKind('settings')[0]!;
    const perms = settings.sentences.filter((s) => s.kind === 'permission');
    expect(perms.map((p) => p.text)).toEqual(
      expect.arrayContaining(['allow: Bash(ls)', 'deny: Bash(rm)']),
    );
    const hooks = settings.sentences.filter((s) => s.kind === 'hook-command');
    expect(hooks.map((h) => h.text)).toEqual(['echo done']);

    for (const d of docs) {
      expect(d.source).toBe('global');
      expect(d.projectRoot).toBeUndefined();
      expect(d.id.startsWith('cfg_')).toBe(true);
    }
  });

  it('ingests project root with CLAUDE.md and .claude/settings.json', async () => {
    const projectRoot = await makeTmp('cfg-proj-');
    await writeFile(path.join(projectRoot, 'CLAUDE.md'), '# Project\n- proj rule\n');
    await mkdir(path.join(projectRoot, '.claude'), { recursive: true });
    await writeFile(
      path.join(projectRoot, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(pnpm test)'] } }),
    );
    await writeFile(
      path.join(projectRoot, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }),
    );

    const missingGlobal = path.join(os.tmpdir(), `cfg-no-global-${Date.now()}-${Math.random()}`);
    const docs = await ingestConfigs({
      globalRoot: missingGlobal,
      projectRoots: [projectRoot],
    });

    expect(docs.length).toBeGreaterThanOrEqual(3);
    for (const d of docs) {
      expect(d.source).toBe('project');
      expect(d.projectRoot).toBe(projectRoot);
    }
    const claudeMd = docs.find((d) => d.kind === 'claude-md')!;
    expect(claudeMd.title).toBe(`${path.basename(projectRoot)} CLAUDE.md`);

    const settingsDocs = docs.filter((d) => d.kind === 'settings');
    expect(settingsDocs).toHaveLength(2);
  });

  it('returns empty list when global root is missing and no projects given', async () => {
    const missing = path.join(os.tmpdir(), `cfg-missing-${Date.now()}-${Math.random()}`);
    const docs = await ingestConfigs({ globalRoot: missing, projectRoots: [] });
    expect(docs).toEqual([]);
  });

  it('falls back to filename for skill without front-matter', async () => {
    const globalRoot = await makeTmp('cfg-skill-nofm-');
    await mkdir(path.join(globalRoot, 'skills', 'bare'), { recursive: true });
    await writeFile(
      path.join(globalRoot, 'skills', 'bare', 'SKILL.md'),
      '# Bare skill\n- one rule\n',
    );

    const docs = await ingestConfigs({ globalRoot, projectRoots: [] });
    const skill = docs.find((d) => d.kind === 'skill')!;
    expect(skill.title).toBe('bare');
  });

  it('skips fenced code blocks in markdown', async () => {
    const globalRoot = await makeTmp('cfg-fence-');
    await writeFile(
      path.join(globalRoot, 'CLAUDE.md'),
      [
        '# Top',
        '',
        '- visible bullet',
        '',
        '```',
        '- not a bullet',
        '# not a heading',
        'paragraph that should not appear',
        '```',
        '',
        'after fence paragraph.',
        '',
      ].join('\n'),
    );

    const docs = await ingestConfigs({ globalRoot, projectRoots: [] });
    const cmd = docs.find((d) => d.kind === 'claude-md')!;
    const allText = cmd.sentences.map((s) => s.text).join('\n');
    expect(allText).toContain('visible bullet');
    expect(allText).toContain('after fence paragraph');
    expect(allText).not.toContain('not a bullet');
    expect(allText).not.toContain('not a heading');
    expect(allText).not.toContain('paragraph that should not appear');
  });

  it('skips malformed settings.json without throwing, ingests others', async () => {
    const globalRoot = await makeTmp('cfg-bad-json-');
    await writeFile(path.join(globalRoot, 'CLAUDE.md'), '# Hi\n');
    await writeFile(path.join(globalRoot, 'settings.json'), '{not json');

    const docs = await ingestConfigs({ globalRoot, projectRoots: [] });
    expect(docs.find((d) => d.kind === 'claude-md')).toBeDefined();
    const settings = docs.find((d) => d.kind === 'settings');
    expect(settings).toBeDefined();
    expect(settings!.sentences).toEqual([]);
  });
});
