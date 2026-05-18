import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { buildPlaybookCandidatesFile } from './playbook.js';

/**
 * Sanity assertion called out in the spec: a fixture transcript with
 * "first principles" + a downstream audit-passed claim must surface
 * the phrasing in the output. If this stops going green the playbook
 * pipeline has lost the canonical ground-truth case.
 */
describe('buildPlaybookCandidatesFile — ground-truth + audit join', () => {
  const tmpRoot = path.join(
    os.tmpdir(),
    `chat-arch-playbook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('surfaces "first principles" and pairs it with the downstream pass', async () => {
    const outDir = tmpRoot;
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    // Fixture transcript — JSONL with two user turns. The second user
    // turn invokes "first principles"; the assistant turn that follows
    // contains a fix-claim that the audit verifier (mocked below)
    // judged as `pass`.
    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'Try implementing the parser please.' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'Done — added a draft parser.' },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'Hold on — go back to first principles and rederive the grammar.',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: 'Verified the grammar by rederiving — fixed the precedence bug.',
        },
      }),
    ].join('\n');

    const transcriptPath = path.join('transcripts', 'sess-fp.jsonl');
    await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

    // Minimal audit-results.json fixture. The audit claim sits at
    // lineNumber 4 (the assistant turn after the user's first-principles
    // invocation at lineNumber 3) and is marked `pass`.
    const auditResults = {
      version: 1,
      generatedAt: 0,
      totals: { pass: 1, fail: 0, inconclusive: 0 },
      results: [
        {
          sessionId: 'sess-fp',
          source: 'cli-direct',
          lineNumber: 4,
          claimType: 'fix-claim',
          span: 'fixed the precedence bug',
          surroundingContext: '',
          outcome: 'pass',
          reason: 'evidence in following assistant turn',
        },
      ],
    };
    await writeFile(
      path.join(outDir, 'analysis', 'audit-results.json'),
      JSON.stringify(auditResults, null, 2),
      'utf8',
    );

    const entry: UnifiedSessionEntry = {
      id: 'sess-fp',
      source: 'cli-direct',
      title: 'fixture',
      preview: '',
      messageCount: 4,
      createdAt: 0,
      updatedAt: 0,
      transcriptPath,
    } as UnifiedSessionEntry;
    const manifest: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cli: 1, cloud: 0, cowork: 0, total: 1 },
      sessions: [entry],
    } as SessionManifest;

    const result = await buildPlaybookCandidatesFile(manifest, {
      outDir,
      now: 1,
    });

    expect(result.hasAuditSignal).toBe(true);

    const fpPattern = result.file.patterns.find(
      (p) => p.patternKey === 'first-principles',
    );
    expect(fpPattern, 'first-principles pattern missing from output').toBeDefined();
    expect(fpPattern?.occurrenceCount).toBe(1);
    expect(fpPattern?.sessionIds).toEqual(['sess-fp']);
    expect(fpPattern?.hits[0]?.lineNumber).toBe(3);

    // The audit claim at line 4 is downstream of the line-3 phrasing
    // and is a pass — the join should yield passRate = 1.0.
    expect(fpPattern?.audit.pass).toBe(1);
    expect(fpPattern?.audit.fail).toBe(0);
    expect(fpPattern?.audit.passRate).toBe(1);

    // With audit signal present, score = occurrence * passRate.
    expect(fpPattern?.score).toBe(1);
  });

  it('degrades to occurrence-only ranking when audit-results.json is absent', async () => {
    const outDir = path.join(tmpRoot, 'no-audit');
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    const transcript = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'Use an adversarial review team on this plan before we ship.',
        },
      }),
    ].join('\n');
    const transcriptPath = path.join('transcripts', 'sess-adv.jsonl');
    await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

    const entry: UnifiedSessionEntry = {
      id: 'sess-adv',
      source: 'cli-direct',
      title: 'fixture',
      preview: '',
      messageCount: 1,
      createdAt: 0,
      updatedAt: 0,
      transcriptPath,
    } as UnifiedSessionEntry;
    const manifest: SessionManifest = {
      schemaVersion: 1,
      generatedAt: 0,
      counts: { cli: 1, cloud: 0, cowork: 0, total: 1 },
      sessions: [entry],
    } as SessionManifest;

    const result = await buildPlaybookCandidatesFile(manifest, {
      outDir,
      now: 1,
    });

    expect(result.hasAuditSignal).toBe(false);
    const advPattern = result.file.patterns.find(
      (p) => p.patternKey === 'adversarial-review',
    );
    expect(advPattern).toBeDefined();
    expect(advPattern?.occurrenceCount).toBe(1);
    // Score equals occurrence when no audit signal.
    expect(advPattern?.score).toBe(1);
    expect(advPattern?.audit.pass).toBe(0);
  });
});
