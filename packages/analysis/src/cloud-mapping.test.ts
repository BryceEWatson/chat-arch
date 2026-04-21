import { describe, it, expect } from 'vitest';
import type { CloudConversation, CloudProject, UnifiedSessionEntry } from '@chat-arch/schema';
import { buildCloudEntries, buildEntry, compileProjectPatterns } from './cloud-mapping.js';

// `validateEntries` lives in the Node exporter (schema-shape integration
// check with error-accumulation). The analysis package is runtime-neutral,
// so we pin the equivalent invariants inline here: every required field
// is set and `cwdKind === 'none'` on cloud entries.
function assertEntryShape(e: UnifiedSessionEntry): void {
  expect(typeof e.id).toBe('string');
  expect(e.source).toBe('cloud');
  expect(typeof e.startedAt).toBe('number');
  expect(typeof e.updatedAt).toBe('number');
  expect(e.cwdKind).toBe('none');
}

// ---------------------------------------------------------------------------
// Fixtures — deliberately cover the branches called out in the review doc:
// empty, summary-present, tool-use-heavy, nameless, unparseable timestamps,
// unknown content-block types.
// ---------------------------------------------------------------------------

function emptyConversation(): CloudConversation {
  return {
    uuid: '11111111-1111-1111-1111-111111111111',
    name: '',
    summary: '',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    account: { uuid: 'user-0000' },
    chat_messages: [],
  };
}

function summaryConversation(): CloudConversation {
  return {
    uuid: '22222222-2222-2222-2222-222222222222',
    name: 'Optimizing the B2B pipeline',
    summary:
      '**Conversation overview**\n\nThe user presented a comprehensive optimization challenge for their B2B SaaS pipeline and discussed strategies.',
    created_at: '2025-06-01T12:00:00Z',
    updated_at: '2025-06-01T13:00:00Z',
    account: { uuid: 'user-0000' },
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        sender: 'human',
        text: 'Hi there, help me optimize my pipeline.',
        content: [{ type: 'text', text: 'Hi there, help me optimize my pipeline.' }],
        created_at: '2025-06-01T12:00:00Z',
        updated_at: '2025-06-01T12:00:00Z',
        attachments: [],
        files: [],
      },
      {
        uuid: 'm2',
        parent_message_uuid: 'm1',
        sender: 'assistant',
        text: 'Sure — here are ideas.',
        content: [{ type: 'text', text: 'Sure — here are ideas.' }],
        created_at: '2025-06-01T12:01:00Z',
        updated_at: '2025-06-01T12:01:00Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

function toolHeavyConversation(): CloudConversation {
  return {
    uuid: '33333333-3333-3333-3333-333333333333',
    name: 'Sweeping artifacts',
    summary: '',
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T10:30:00Z',
    account: { uuid: 'user-0000' },
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        sender: 'human',
        text: 'Search the web for cats',
        content: [{ type: 'text', text: 'Search the web for cats' }],
        created_at: '2026-01-15T10:00:00Z',
        updated_at: '2026-01-15T10:00:00Z',
        attachments: [],
        files: [],
      },
      {
        uuid: 'm2',
        parent_message_uuid: 'm1',
        sender: 'assistant',
        text: 'searching',
        content: [
          { type: 'tool_use', id: 'tu1', name: 'web_search', input: { q: 'cats' } },
          { type: 'tool_use', id: 'tu2', name: 'web_search', input: { q: 'cats 2' } },
          { type: 'tool_use', id: 'tu3', name: 'artifacts', input: {} },
          // Tool-use with missing name — must be ignored.
          { type: 'tool_use', id: 'tu4', name: '', input: {} },
          // Unknown block type — must be ignored for tool histogram.
          { type: 'weird_new_thing', foo: 'bar' },
        ],
        created_at: '2026-01-15T10:01:00Z',
        updated_at: '2026-01-15T10:01:00Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

function unparseableConversation(): CloudConversation {
  return {
    ...summaryConversation(),
    uuid: '44444444-4444-4444-4444-444444444444',
    created_at: 'not-a-date',
    updated_at: 'also-bad',
  };
}

describe('buildEntry (pure, browser-safe)', () => {
  it('maps summary-present conversation into cloud-name entry with summary preview', () => {
    const e = buildEntry(summaryConversation())!;
    expect(e).not.toBeNull();
    expect(e.source).toBe('cloud');
    expect(e.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(e.rawSessionId).toBe('22222222-2222-2222-2222-222222222222');
    expect(e.title).toBe('Optimizing the B2B pipeline');
    expect(e.titleSource).toBe('cloud-name');
    expect(e.summary).toMatch(/^\*\*Conversation overview\*\*/);
    expect(e.preview).not.toBeNull();
    expect(e.preview!.startsWith('**Conversation overview**')).toBe(true);
    expect(e.userTurns).toBe(1);
    expect(e.assistantTurns).toBe(1);
    expect(e.model).toBeNull();
    expect(e.cwdKind).toBe('none');
    expect(e.totalCostUsd).toBeNull();
    expect(e.transcriptPath).toBe('cloud-conversations/22222222-2222-2222-2222-222222222222.json');
    expect(e.topTools).toBeUndefined();
    expect(e.durationMs).toBe(60 * 60 * 1000);
  });

  it('falls back to UNTITLED_SESSION + preview=null for empty conv', () => {
    const e = buildEntry(emptyConversation())!;
    expect(e.title).toBe('Untitled session');
    expect(e.titleSource).toBe('fallback');
    expect(e.preview).toBeNull();
    expect(e.userTurns).toBe(0);
    expect(e.assistantTurns).toBeUndefined();
    expect(e.summary).toBeUndefined();
    expect(e.topTools).toBeUndefined();
    expect(e.durationMs).toBe(0);
  });

  it('tallies tool_use blocks, ignores nameless & unknown block types', () => {
    const e = buildEntry(toolHeavyConversation())!;
    expect(e.topTools).toEqual({ web_search: 2, artifacts: 1 });
    expect(e.title).toBe('Sweeping artifacts');
    expect(e.titleSource).toBe('cloud-name');
    // No summary -> preview falls back to first human text.
    expect(e.preview).toBe('Search the web for cats');
  });

  it('returns null when timestamps are unparseable', () => {
    expect(buildEntry(unparseableConversation())).toBeNull();
  });
});

describe('buildCloudEntries (pure aggregate)', () => {
  it('returns sorted-desc entries, conversationsById map, summary count, skips', () => {
    const data = {
      conversations: [
        emptyConversation(),
        summaryConversation(),
        toolHeavyConversation(),
        unparseableConversation(),
      ],
    };
    const { entries, conversationsById, summaryCount, conversationsSkipped } =
      buildCloudEntries(data);

    expect(entries).toHaveLength(3);
    expect(conversationsSkipped).toBe(1);
    expect(summaryCount).toBe(1);

    // Sort order: toolHeavy (2026) > summary (2025-06) > empty (2025-01).
    expect(entries[0]!.id).toBe('33333333-3333-3333-3333-333333333333');
    expect(entries[1]!.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(entries[2]!.id).toBe('11111111-1111-1111-1111-111111111111');

    // conversationsById carries only the entries that survived.
    expect(conversationsById.size).toBe(3);
    expect(conversationsById.has('44444444-4444-4444-4444-444444444444')).toBe(false);
    const conv = conversationsById.get('22222222-2222-2222-2222-222222222222')!;
    expect(conv.chat_messages).toHaveLength(2);
  });

  it('produces entries whose required shape is intact', () => {
    const { entries } = buildCloudEntries({
      conversations: [emptyConversation(), summaryConversation(), toolHeavyConversation()],
    });
    expect(entries).toHaveLength(3);
    for (const e of entries) assertEntryShape(e);
  });

  it('is pure — same input produces same output', () => {
    const data = {
      conversations: [summaryConversation(), toolHeavyConversation()],
    };
    const a = buildCloudEntries(data);
    const b = buildCloudEntries(data);
    expect(JSON.stringify(a.entries)).toEqual(JSON.stringify(b.entries));
  });

  it('handles empty input', () => {
    const r = buildCloudEntries({ conversations: [] });
    expect(r.entries).toEqual([]);
    expect(r.conversationsById.size).toBe(0);
    expect(r.summaryCount).toBe(0);
    expect(r.conversationsSkipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Project labeling — derived from the cloud export's own projects.json.
// Safeguards verified here match the validation run against a real 1041-
// conversation corpus (see the adjacent design notes): length >= 5 and a
// common-word denylist are what kept the false-positive rate near zero at
// the cost of ~5% match coverage. That trade-off is the reason these tests
// pin the filter behavior instead of the raw regex surface.
// ---------------------------------------------------------------------------

function project(name: string, overrides: Partial<CloudProject> = {}): CloudProject {
  return {
    uuid: `proj-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    description: '',
    is_private: true,
    is_starter_project: false,
    prompt_template: '',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    creator: { uuid: 'user-0000', full_name: 'Test User' },
    docs: [],
    ...overrides,
  };
}

describe('compileProjectPatterns', () => {
  it('drops names shorter than the length floor', () => {
    const out = compileProjectPatterns([project('AI'), project('starz')]);
    expect(out.map((p) => p.displayName)).toEqual(['starz']);
  });

  it('drops common-word names on the denylist (case-insensitive)', () => {
    const out = compileProjectPatterns([
      project('Research'),
      project('design'),
      project('Art'), // dropped by length too, but harmlessly
      project('PetConnect'),
    ]);
    expect(out.map((p) => p.displayName)).toEqual(['PetConnect']);
  });

  it('returns [] for undefined / empty input', () => {
    expect(compileProjectPatterns(undefined)).toEqual([]);
    expect(compileProjectPatterns([])).toEqual([]);
  });

  it('escapes regex metacharacters in project names (no crash, literal match)', () => {
    // Pathological project name containing regex specials. The goal is
    // narrow: `new RegExp(...)` must not throw, and the pattern must
    // treat the specials as literals rather than regex operators.
    //
    // Word-boundary limitation: `\b` only matches between a word char
    // (`\w`) and a non-word char, so project names that START or END
    // with a non-word character can produce a regex that never matches
    // — this is intentional and matches the behavior real claude.ai
    // project names (which are word-bounded in practice) expect. We
    // don't try to paper over it; we just verify no crash and no
    // over-matching on regex-operator text.
    const patterns = compileProjectPatterns([project('foo.bar-baz')]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.re.test('Notes on foo.bar-baz deployment')).toBe(true);
    // The `.` must be literal, not "any char" — so `fooXbar-baz` must not match.
    expect(patterns[0]!.re.test('Notes on fooXbar-baz deployment')).toBe(false);
  });
});

describe('buildEntry with project patterns', () => {
  function convWithName(name: string): CloudConversation {
    return { ...summaryConversation(), name };
  }

  it('sets entry.project on word-boundary title match', () => {
    const patterns = compileProjectPatterns([project('PetConnect')]);
    const e = buildEntry(convWithName('Data ingestion for PetConnect EEG'), patterns)!;
    expect(e.project).toBe('PetConnect');
  });

  it('leaves entry.project undefined when no pattern matches', () => {
    const patterns = compileProjectPatterns([project('PetConnect')]);
    const e = buildEntry(convWithName('Random unrelated title'), patterns)!;
    expect(e.project).toBeUndefined();
  });

  it('first-match wins when multiple project names appear', () => {
    const patterns = compileProjectPatterns([project('starz'), project('PetConnect')]);
    const e = buildEntry(
      convWithName('Comparing starz and PetConnect approaches'),
      patterns,
    )!;
    expect(e.project).toBe('starz');
  });

  it('respects word boundary — substring matches are rejected', () => {
    // Adversarial: "starz" appears inside "starzy" — word-boundary regex
    // must reject this. Without the safeguard, short project names would
    // pull in arbitrary titles that merely contain the letters.
    const patterns = compileProjectPatterns([project('starz')]);
    const e = buildEntry(convWithName('Discussing starzy marketing plans'), patterns)!;
    expect(e.project).toBeUndefined();
  });

  it('matches case-insensitively', () => {
    const patterns = compileProjectPatterns([project('PetConnect')]);
    const e = buildEntry(convWithName('petconnect database schema'), patterns)!;
    expect(e.project).toBe('PetConnect');
  });

  it('falls back to summary when the title does not match', () => {
    // Title-first / summary-fallback matching roughly doubles coverage on
    // real claude.ai data (users often write generic titles like "bug fix"
    // for conversations that happen inside a project with a distinctive
    // name). The summary fallback catches these; the false-positive rate
    // on real 1041-conversation data is <5% of the lifted set, worth the
    // coverage gain. Pin the fallback behavior here.
    const patterns = compileProjectPatterns([project('PetConnect')]);
    const conv: CloudConversation = {
      ...summaryConversation(),
      name: 'Database schema update',
      summary: 'Working through the PetConnect ingestion pipeline migrations.',
    };
    const e = buildEntry(conv, patterns)!;
    expect(e.project).toBe('PetConnect');
  });

  it('prefers title match over summary match when both contain different projects', () => {
    // Title carries higher signal (user-authored, declarative). When the
    // title names project A and the summary names project B, we tag A —
    // the user chose the title to describe what the conversation is
    // about, whereas the summary is Claude's interpretation.
    const patterns = compileProjectPatterns([project('starz'), project('PetConnect')]);
    const conv: CloudConversation = {
      ...summaryConversation(),
      name: 'starz generative art review',
      summary: 'Also discussed PetConnect roadmap briefly at the end.',
    };
    const e = buildEntry(conv, patterns)!;
    expect(e.project).toBe('starz');
  });

  it('omits entry.project when called with no patterns (back-compat)', () => {
    const e = buildEntry(convWithName('Data ingestion for PetConnect EEG'))!;
    expect(e.project).toBeUndefined();
  });
});

describe('buildCloudEntries propagates project patterns from data.projects', () => {
  it('labels entries whose titles name one of the user-created projects', () => {
    const conversations: CloudConversation[] = [
      { ...summaryConversation(), uuid: 'conv-1', name: 'starz generative art' },
      { ...summaryConversation(), uuid: 'conv-2', name: 'random errand' },
    ];
    const { entries } = buildCloudEntries({
      conversations,
      projects: [project('starz'), project('art')], // "art" dropped by denylist
    });
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(byId.get('conv-1')!.project).toBe('starz');
    expect(byId.get('conv-2')!.project).toBeUndefined();
  });

  it('no-op when data.projects is omitted', () => {
    const { entries } = buildCloudEntries({
      conversations: [{ ...summaryConversation(), uuid: 'conv-1', name: 'starz launch' }],
    });
    expect(entries[0]!.project).toBeUndefined();
  });
});
