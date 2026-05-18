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

  it('sinks score to 0 when a pattern has audit overlap but zero passes', async () => {
    // Regression for the QA finding: with audit data present and a
    // pattern whose downstream window contains only fails/inconclusive
    // (passRate = 0), the score must collapse to 0 — NOT silently
    // fall back to raw occurrence. Otherwise the kernel's docstring
    // promise ("patterns that don't correlate with pass-verdicts
    // surface with a 0% pass-rate score and rank below the real
    // methods") is broken.
    const outDir = path.join(tmpRoot, 'zero-pass');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    const transcript = [
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: 'OK, what are the alternative approaches here?',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'I broke the build, sorry.' },
      }),
    ].join('\n');
    const transcriptPath = path.join('transcripts', 'sess-tr.jsonl');
    await writeFile(path.join(outDir, transcriptPath), transcript, 'utf8');

    const auditResults = {
      version: 1,
      generatedAt: 0,
      totals: { pass: 0, fail: 1, inconclusive: 0 },
      results: [
        {
          sessionId: 'sess-tr',
          source: 'cli-direct',
          lineNumber: 2,
          claimType: 'fix-claim',
          span: 'broke the build',
          surroundingContext: '',
          outcome: 'fail',
          reason: 'evidence to the contrary',
        },
      ],
    };
    await writeFile(
      path.join(outDir, 'analysis', 'audit-results.json'),
      JSON.stringify(auditResults),
      'utf8',
    );

    const entry: UnifiedSessionEntry = {
      id: 'sess-tr',
      source: 'cli-direct',
      title: 'fixture',
      preview: '',
      messageCount: 2,
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

    const result = await buildPlaybookCandidatesFile(manifest, { outDir, now: 1 });
    const tradeoffsPattern = result.file.patterns.find(
      (p) => p.patternKey === 'tradeoffs',
    );
    expect(tradeoffsPattern, 'tradeoffs pattern missing').toBeDefined();
    expect(tradeoffsPattern?.occurrenceCount).toBe(1);
    expect(tradeoffsPattern?.audit.pass).toBe(0);
    expect(tradeoffsPattern?.audit.fail).toBe(1);
    expect(tradeoffsPattern?.audit.passRate).toBe(0);
    // The critical assertion: score must be 0, NOT 1 (the raw count).
    expect(tradeoffsPattern?.score).toBe(0);
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

  it('parses cloud transcripts and produces lineNumbers that match the audit pipeline convention', async () => {
    // Pins the cloud lineNumber convention: 1-based ordinal into
    // `chat_messages[]`, incrementing on EVERY entry (including
    // assistant messages that the audit pipeline would also count).
    // The audit pipeline iterates the same array with `let lineNumber = 1; lineNumber += 1`
    // per loop iteration regardless of sender, so this fixture also
    // catches future drift between the two parsers.
    const outDir = path.join(tmpRoot, 'cloud-fixture');
    await mkdir(path.join(outDir, 'analysis'), { recursive: true });
    await mkdir(path.join(outDir, 'transcripts'), { recursive: true });

    const cloudTranscript = {
      chat_messages: [
        { sender: 'human', text: 'hey can you start a draft' }, // ordinal 1
        { sender: 'assistant', text: 'sure, here is a draft' }, // ordinal 2
        { sender: 'human', text: 'OK go back to first principles instead' }, // ordinal 3
        { sender: 'assistant', text: 'rederived — fixed the model' }, // ordinal 4
      ],
    };
    const transcriptPath = path.join('transcripts', 'sess-cloud.json');
    await writeFile(
      path.join(outDir, transcriptPath),
      JSON.stringify(cloudTranscript),
      'utf8',
    );

    const auditResults = {
      version: 1,
      generatedAt: 0,
      totals: { pass: 1, fail: 0, inconclusive: 0 },
      results: [
        {
          sessionId: 'sess-cloud',
          source: 'cloud',
          // Assistant turn at chat_messages[3] → 1-based lineNumber 4.
          lineNumber: 4,
          claimType: 'fix-claim',
          span: 'fixed the model',
          surroundingContext: '',
          outcome: 'pass',
          reason: 'evidence in following assistant turn',
        },
      ],
    };
    await writeFile(
      path.join(outDir, 'analysis', 'audit-results.json'),
      JSON.stringify(auditResults),
      'utf8',
    );

    const entry: UnifiedSessionEntry = {
      id: 'sess-cloud',
      source: 'cloud',
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
      counts: { cli: 0, cloud: 1, cowork: 0, total: 1 },
      sessions: [entry],
    } as SessionManifest;

    const result = await buildPlaybookCandidatesFile(manifest, { outDir, now: 1 });
    const fp = result.file.patterns.find((p) => p.patternKey === 'first-principles');
    expect(fp, 'first-principles missing from cloud fixture').toBeDefined();
    expect(fp?.hits[0]?.lineNumber).toBe(3);
    // The downstream audit claim at lineNumber 4 sits in the next-5
    // window of the line-3 hit and counts as pass.
    expect(fp?.audit.pass).toBe(1);
    expect(fp?.audit.passRate).toBe(1);
  });
});
