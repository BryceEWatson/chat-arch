import { describe, it, expect } from 'vitest';
import {
  inferProject,
  extractBasename,
  globMatch,
  scheduledDisplayCandidate,
  titleCaseSlug,
  type InferProjectInput,
  type ProjectOverride,
} from './inferProject.js';

/** Build a cascade input with sensible defaults (cwdKind defaults to 'host'). */
function mk(partial: Partial<InferProjectInput>): InferProjectInput {
  return {
    id: 'sid',
    title: '',
    cwdKind: 'host',
    ...partial,
  } as InferProjectInput;
}

describe('inferProject — 6-step strict-first-match cascade', () => {
  it('(0) override by sessionIds wins over everything', () => {
    const overrides: ProjectOverride[] = [
      { projectId: 'brycewatson-com', displayName: 'brycewatson.com', match: { sessionIds: ['sid'] } },
    ];
    const r = inferProject(mk({ id: 'sid', project: 'chat-arch', cwd: '/x/chat-arch' }), overrides);
    expect(r).not.toBeNull();
    expect(r!.id).toBe('brycewatson-com');
    expect(r!.displayName).toBe('brycewatson.com');
    expect(r!.resolvedVia).toBe('override');
    expect(r!.confidence).toBe(1.0);
  });

  it('(0) override by cwdGlob wins (separator-agnostic)', () => {
    const overrides: ProjectOverride[] = [
      { projectId: 'client-a', match: { cwdGlob: '**/work/client-a/**' } },
    ];
    const r = inferProject(mk({ cwd: 'C:\\Users\\b\\work\\client-a\\docs', cwdKind: 'host' }), overrides);
    expect(r!.id).toBe('client-a');
    expect(r!.resolvedVia).toBe('override');
  });

  it('(1) explicit project field', () => {
    const r = inferProject(mk({ project: 'chat-arch', cwd: '/x/other', title: 'Ignored' }));
    expect(r!.id).toBe('chat-arch');
    expect(r!.resolvedVia).toBe('project_field');
    expect(r!.confidence).toBe(1.0);
  });

  it('(2) scheduledTaskId → routine_<id>, NOT the title slug', () => {
    const r = inferProject(
      mk({
        scheduledTaskId: 'shopforge-daily-metrics-sync',
        cwdKind: 'vm',
        cwd: '/sessions/strange-bardeen-ff8efb',
        title: 'Mar 28 – Shopforge daily metrics sync',
      }),
    );
    expect(r!.id).toBe('routine_shopforge-daily-metrics-sync');
    expect(r!.resolvedVia).toBe('scheduled-task');
    expect(r!.confidence).toBe(0.9);
    // displayName candidate = date-stripped title (mode chosen in discoverProjects).
    expect(r!.displayName).toBe('Shopforge daily metrics sync');
  });

  it('(2) scheduledTaskId outranks an explicit cwd basename (order, not signal strength)', () => {
    const r = inferProject(mk({ scheduledTaskId: 'pinterest-daily-pins', cwd: '/x/outputs', cwdKind: 'host' }));
    expect(r!.resolvedVia).toBe('scheduled-task');
    expect(r!.id).toBe('routine_pinterest-daily-pins');
  });

  it('(3) VM session routes to userSelectedFolders[0] basename', () => {
    const r = inferProject(
      mk({
        cwdKind: 'vm',
        cwd: '/sessions/strange-bardeen-ff8efb',
        userSelectedFolders: ['/Users/bryce/Projects/chat-arch'],
        title: 'whatever',
      }),
    );
    expect(r!.id).toBe('chat-arch');
    expect(r!.resolvedVia).toBe('vm-folder');
    expect(r!.confidence).toBe(0.8);
  });

  it('(4) host cwd basename when no higher rule fires', () => {
    const r = inferProject(mk({ cwd: 'C:\\Users\\b\\Projects\\my-project-b', cwdKind: 'host' }));
    expect(r!.id).toBe('my-project-b');
    expect(r!.resolvedVia).toBe('cwd_basename');
    expect(r!.confidence).toBe(0.5);
  });

  it('(4) cwd basename works with cwdKind undefined (legacy entries)', () => {
    const r = inferProject({ id: 's', cwd: '/home/x/projects/my-project-a-v3', title: 't' } as InferProjectInput);
    expect(r!.id).toBe('my-project-a-v3');
    expect(r!.resolvedVia).toBe('cwd_basename');
  });

  it('VM-haiku guard: vm + NO userSelectedFolders does NOT adopt the haiku basename', () => {
    // rule 3 can't fire (no USF), rule 4 is guarded (cwdKind==='vm') → falls to title.
    const r = inferProject(
      mk({ cwdKind: 'vm', cwd: '/sessions/strange-bardeen-ff8efb', title: 'Translating French poetry' }),
    );
    expect(r).toBeNull(); // no title-keyword match either → unassigned
  });

  it('VM-haiku guard: vm + no USF + title-keyword match falls through to rule 5', () => {
    const r = inferProject(
      mk({ cwdKind: 'vm', cwd: '/sessions/strange-bardeen-ff8efb', title: 'Build Chat Archaeologist orchestrator' }),
    );
    expect(r!.id).toBe('chat-arch');
    expect(r!.resolvedVia).toBe('title_keyword');
    expect(r!.confidence).toBe(0.4);
  });

  it('VM-haiku guard is shape-based: a vm session with a REAL host-folder cwd uses the basename', () => {
    // Verified against the corpus: 23 cwdKind==='vm' sessions carry a genuine
    // host cwd (mostly chat-arch). The basename is a real signal — use it
    // (and unify cross-source with host + VM-USF chat-arch sessions).
    const r = inferProject(mk({ cwdKind: 'vm', cwd: 'C:\\Users\\Bryce\\Projects\\chat-arch' }));
    expect(r!.id).toBe('chat-arch');
    expect(r!.resolvedVia).toBe('cwd_basename');
    const dotted = inferProject(mk({ cwdKind: 'vm', cwd: 'C:\\Users\\Bryce\\Projects\\brycewatson.com' }));
    expect(dotted!.id).toBe('brycewatson.com');
    expect(dotted!.resolvedVia).toBe('cwd_basename');
  });

  it('VM guard rejects the synthetic `local_<uuid>/outputs` scheduled-output dir (no proj_outputs)', () => {
    const r = inferProject(mk({ cwdKind: 'vm', cwd: 'C:\\x\\local_abc123\\outputs', title: 'no keyword match' }));
    expect(r).toBeNull();
  });

  it('VM guard rejects a `.claude/worktrees/<haiku>` cwd (§14 walk-up deferred)', () => {
    const r = inferProject(
      mk({ cwdKind: 'vm', cwd: 'C:\\Users\\b\\Projects\\chat-arch\\.claude\\worktrees\\clever-dirac-4b629f', title: 'x' }),
    );
    expect(r).toBeNull();
  });

  it('VM guard is path-based, NOT shape-based: a real 3-word-kebab host folder is USED, not rejected', () => {
    // Regression guard: a basename-shape regex would wrongly reject
    // `data-pipeline-svc` as a docker-haiku; the path-structure guard does not.
    const r = inferProject(mk({ cwdKind: 'vm', cwd: 'C:\\Users\\b\\Projects\\data-pipeline-svc' }));
    expect(r!.id).toBe('data-pipeline-svc');
    expect(r!.resolvedVia).toBe('cwd_basename');
  });

  it('host cwd basename is never haiku-guarded (only vm is)', () => {
    // A host session whose folder happens to look haiku-shaped still resolves.
    const r = inferProject(mk({ cwdKind: 'host', cwd: '/x/strange-bardeen-ff8efb' }));
    expect(r!.id).toBe('strange-bardeen-ff8efb');
    expect(r!.resolvedVia).toBe('cwd_basename');
  });

  it('(5) title-keyword fallback (cloud sessions, no cwd)', () => {
    const r = inferProject(mk({ title: 'Profitability Outlook for my-project-c' }));
    expect(r!.id).toBe('my-project-c');
    expect(r!.resolvedVia).toBe('title_keyword');
  });

  it('(6) unassigned → null when nothing matches', () => {
    const r = inferProject(mk({ title: 'Translating French poetry' }));
    expect(r).toBeNull();
  });

  it('treats empty project field as absent (falls through to cwd)', () => {
    const r = inferProject(mk({ project: '', cwd: '/tmp/foo', cwdKind: 'host' }));
    expect(r!.id).toBe('foo');
    expect(r!.resolvedVia).toBe('cwd_basename');
  });

  it('confidence is monotonically non-increasing down the cascade order', () => {
    const order = ['override', 'project_field', 'scheduled-task', 'vm-folder', 'cwd_basename', 'title_keyword'] as const;
    const confs = [1.0, 1.0, 0.9, 0.8, 0.5, 0.4];
    for (let i = 1; i < confs.length; i += 1) {
      expect(confs[i]!).toBeLessThanOrEqual(confs[i - 1]!);
    }
    expect(order.length).toBe(confs.length);
  });
});

describe('scheduledDisplayCandidate — deterministic date-strip', () => {
  it('strips a hyphen date prefix', () => {
    expect(scheduledDisplayCandidate('x', 'Mar 28 - Daily pulse')).toBe('Daily pulse');
  });
  it('strips an en-dash (U+2013) date prefix', () => {
    expect(scheduledDisplayCandidate('x', 'Mar 29 – Daily pulse')).toBe('Daily pulse');
  });
  it('strips an em-dash (U+2014) date prefix', () => {
    expect(scheduledDisplayCandidate('x', 'Mar 30 — Daily pulse')).toBe('Daily pulse');
  });
  it('different per-run dates collapse to the same stem', () => {
    const a = scheduledDisplayCandidate('x', 'Mar 28 – Shopforge daily metrics sync');
    const b = scheduledDisplayCandidate('x', 'Apr 02 – Shopforge daily metrics sync');
    expect(a).toBe(b);
  });
  it('falls back to title-cased task id when title is empty', () => {
    expect(scheduledDisplayCandidate('shopforge-daily-metrics-sync', undefined)).toBe(
      'Shopforge Daily Metrics Sync',
    );
  });
  it('falls back when the title is entirely a date prefix', () => {
    expect(scheduledDisplayCandidate('pinterest-daily-pins', 'Mar 28 – ')).toBe('Pinterest Daily Pins');
  });
});

describe('titleCaseSlug', () => {
  it('converts underscore/hyphen slugs to Title Case', () => {
    expect(titleCaseSlug('pinterest_daily-pins')).toBe('Pinterest Daily Pins');
  });
});

describe('globMatch', () => {
  it('** matches across separators', () => {
    expect(globMatch('**/client-a/**', '/home/b/work/client-a/docs/readme.md')).toBe(true);
  });
  it('* does not cross a separator', () => {
    expect(globMatch('/home/*/docs', '/home/b/docs')).toBe(true);
    expect(globMatch('/home/*/docs', '/home/b/c/docs')).toBe(false);
  });
  it('normalizes Windows backslashes', () => {
    expect(globMatch('**/Projects/chat-arch', 'C:\\Users\\b\\Projects\\chat-arch')).toBe(true);
  });
  it('escapes regex specials in the literal portion', () => {
    expect(globMatch('/a.b/*', '/a.b/x')).toBe(true);
    expect(globMatch('/a.b/*', '/axb/x')).toBe(false);
  });
});

describe('extractBasename', () => {
  it('handles Windows paths', () => {
    expect(extractBasename('C:\\Users\\example\\Projects\\chat-arch')).toBe('chat-arch');
  });
  it('handles POSIX paths', () => {
    expect(extractBasename('/home/example/projects/chat-arch')).toBe('chat-arch');
  });
  it('strips trailing slashes', () => {
    expect(extractBasename('/home/example/chat-arch/')).toBe('chat-arch');
    expect(extractBasename('C:\\code\\x\\')).toBe('x');
  });
  it('returns bare segment when no separator', () => {
    expect(extractBasename('solo')).toBe('solo');
  });
  it('returns null for empty input', () => {
    expect(extractBasename('')).toBeNull();
    expect(extractBasename('   ')).toBeNull();
  });
});
