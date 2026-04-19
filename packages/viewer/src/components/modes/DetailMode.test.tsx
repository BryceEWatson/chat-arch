import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { UnifiedSessionEntry, CloudConversation } from '@chat-arch/schema';
import { DetailMode } from './DetailMode.js';

function entry(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `Session ${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

function buildConv(uuid: string): CloudConversation {
  return {
    uuid,
    name: 'Test',
    summary: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    account: { uuid: 'u' },
    chat_messages: [
      {
        uuid: 'm1',
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        sender: 'human',
        text: 'hello',
        content: [{ type: 'text', text: 'hello' }],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        attachments: [],
        files: [],
      },
      {
        uuid: 'm2',
        parent_message_uuid: 'm1',
        sender: 'assistant',
        text: 'world',
        content: [{ type: 'text', text: 'world' }],
        created_at: '2026-01-01T00:00:01Z',
        updated_at: '2026-01-01T00:00:01Z',
        attachments: [],
        files: [],
      },
    ],
  };
}

describe('DetailMode prev/next (AC9)', () => {
  it('renders PREV + NEXT buttons', () => {
    const s = entry('s1');
    render(
      <DetailMode
        session={s}
        dataRoot="/x"
        cache={new Map()}
        setCache={() => {}}
        onBack={() => {}}
        prevId="s0"
        nextId="s2"
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(screen.getByText(/PREV/)).toBeDefined();
    expect(screen.getByText(/NEXT/)).toBeDefined();
  });

  it('disables PREV at left edge and NEXT at right edge', () => {
    const s = entry('s1');
    render(
      <DetailMode
        session={s}
        dataRoot="/x"
        cache={new Map()}
        setCache={() => {}}
        onBack={() => {}}
        prevId={null}
        nextId={null}
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    const prev = screen.getByText(/PREV/);
    const next = screen.getByText(/NEXT/);
    expect(prev.className).toContain('lcars-detail-mode__nav--disabled');
    expect(next.className).toContain('lcars-detail-mode__nav--disabled');
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    expect(next.getAttribute('aria-disabled')).toBe('true');
  });

  it('click and [ / ] keyboard shortcuts trigger onPrev / onNext', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <DetailMode
        session={entry('s1')}
        dataRoot="/x"
        cache={new Map()}
        setCache={() => {}}
        onBack={() => {}}
        prevId="s0"
        nextId="s2"
        onPrev={onPrev}
        onNext={onNext}
      />,
    );
    fireEvent.click(screen.getByText(/PREV/));
    expect(onPrev).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText(/NEXT/));
    expect(onNext).toHaveBeenCalledTimes(1);

    // Keyboard: `[` triggers prev, `]` triggers next. Fire on document so
    // the DetailMode's window-level listener picks them up.
    fireEvent.keyDown(document.body, { key: '[' });
    expect(onPrev).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document.body, { key: ']' });
    expect(onNext).toHaveBeenCalledTimes(2);
  });

  it('does not trigger keyboard shortcuts when typing in an input', () => {
    const onPrev = vi.fn();
    render(
      <div>
        <input data-testid="filter-input" />
        <DetailMode
          session={entry('s1')}
          dataRoot="/x"
          cache={new Map()}
          setCache={() => {}}
          onBack={() => {}}
          prevId="s0"
          nextId="s2"
          onPrev={onPrev}
          onNext={() => {}}
        />
      </div>,
    );
    const input = screen.getByTestId('filter-input');
    fireEvent.keyDown(input, { key: '[' });
    expect(onPrev).not.toHaveBeenCalled();
  });
});

describe('DetailMode copy-transcript (AC10)', () => {
  beforeEach(() => {
    // Stub navigator.clipboard before each test.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  it('produces Markdown with ## Human / ## Assistant headers for cloud sessions', async () => {
    const conv = buildConv('c1');
    const session = entry('c1', { transcriptPath: 'cloud-conversations/c1.json' });
    const conversationsById = new Map<string, CloudConversation>([['c1', conv]]);
    const cache = new Map();

    const setCache = (next: typeof cache) => {
      // Keep the mock in sync so the component's useEffect can populate.
      for (const [k, v] of next) cache.set(k, v);
    };

    const { rerender } = render(
      <DetailMode
        session={session}
        dataRoot="/x"
        cache={cache}
        setCache={setCache}
        onBack={() => {}}
        prevId={null}
        nextId={null}
        onPrev={() => {}}
        onNext={() => {}}
        uploadedConversationsById={conversationsById}
      />,
    );
    // Re-render with the updated cache so current.status === 'ready'.
    await waitFor(() => {
      expect(cache.size).toBeGreaterThan(0);
    });
    rerender(
      <DetailMode
        session={session}
        dataRoot="/x"
        cache={cache}
        setCache={setCache}
        onBack={() => {}}
        prevId={null}
        nextId={null}
        onPrev={() => {}}
        onNext={() => {}}
        uploadedConversationsById={conversationsById}
      />,
    );

    fireEvent.click(screen.getByText('COPY TRANSCRIPT'));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalled();
    });
    const md = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(md).toContain('# Session c1');
    expect(md).toContain('## Human');
    expect(md).toContain('## Assistant');
    expect(md).toContain('hello');
    expect(md).toContain('world');
    await waitFor(() => {
      expect(screen.getByText('COPIED ✓')).toBeDefined();
    });
  });
});
