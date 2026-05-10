import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { Topic, Project, UnifiedSessionEntry } from '@chat-arch/schema';
import { TopicsMode } from './TopicsMode.js';

/**
 * Phase 3 opt-in tests. The TOPICS surface is gated behind a
 * `chat-arch:topics-opt-in` localStorage flag — until the user clicks
 * ENABLE TOPICS we render a disclosure card describing the embedding-
 * model download, NOT the topic index. Once opted in (and persisted),
 * the populated mode appears and a small `(disable)` link in the
 * header lets the user revoke the choice.
 */

const OPT_IN_KEY = 'chat-arch:topics-opt-in';

function topic(id: string, displayName: string, sessionIds: string[] = []): Topic {
  return {
    id,
    displayName,
    sessionIds,
    projectIds: [],
  } as Topic;
}

function session(id: string): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: Date.UTC(2026, 3, 1),
    durationMs: 0,
    title: `T ${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
  } as UnifiedSessionEntry;
}

const projects: readonly Project[] = [];
const sessions: readonly UnifiedSessionEntry[] = [session('a')];
const topics: readonly Topic[] = [topic('t1', 'Refactoring', ['a'])];

beforeEach(() => {
  // Each test starts with a clean opt-in slate so we never leak state
  // between cases — vitest doesn't isolate localStorage by default.
  window.localStorage.removeItem(OPT_IN_KEY);
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(OPT_IN_KEY);
});

describe('TopicsMode opt-in gate (Phase 3)', () => {
  it('shows the opt-in placeholder when localStorage key is absent', () => {
    render(
      <TopicsMode
        topics={topics}
        projects={projects}
        sessions={sessions}
        selectedTopicId={null}
        onSelectTopic={() => {}}
        onSelectSession={() => {}}
      />,
    );
    expect(screen.getByText('ENABLE TOPIC CLUSTERING')).toBeDefined();
    expect(screen.getByText(/36MB embedding model/)).toBeDefined();
    expect(screen.getByText(/nothing about your conversations is uploaded/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'ENABLE TOPICS' })).toBeDefined();
    // Populated mode markers must NOT be present yet.
    expect(screen.queryByText('Refactoring', { exact: false })).toBeNull();
  });

  it('treats values other than the literal string "true" as not opted in', () => {
    // Defensive: a stray `'1'` or `'yes'` from an unrelated codepath
    // shouldn't accidentally enable the surface. Only the canonical
    // `'true'` writes count.
    window.localStorage.setItem(OPT_IN_KEY, '1');
    render(
      <TopicsMode
        topics={topics}
        projects={projects}
        sessions={sessions}
        selectedTopicId={null}
        onSelectTopic={() => {}}
        onSelectSession={() => {}}
      />,
    );
    expect(screen.getByText('ENABLE TOPIC CLUSTERING')).toBeDefined();
  });

  it('clicking ENABLE TOPICS persists "true" and re-renders the populated mode', () => {
    render(
      <TopicsMode
        topics={topics}
        projects={projects}
        sessions={sessions}
        selectedTopicId={null}
        onSelectTopic={() => {}}
        onSelectSession={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ENABLE TOPICS' }));
    expect(window.localStorage.getItem(OPT_IN_KEY)).toBe('true');
    // Gate is gone — populated TOPICS surface is now visible.
    expect(screen.queryByText('ENABLE TOPIC CLUSTERING')).toBeNull();
    expect(screen.getByRole('button', { name: /open topic Refactoring/i })).toBeDefined();
  });

  it('renders the populated mode immediately when localStorage is already "true"', () => {
    window.localStorage.setItem(OPT_IN_KEY, 'true');
    render(
      <TopicsMode
        topics={topics}
        projects={projects}
        sessions={sessions}
        selectedTopicId={null}
        onSelectTopic={() => {}}
        onSelectSession={() => {}}
      />,
    );
    expect(screen.queryByText('ENABLE TOPIC CLUSTERING')).toBeNull();
    expect(screen.getByRole('button', { name: /open topic Refactoring/i })).toBeDefined();
  });

  it('clicking the (disable) link clears the key and re-renders the placeholder', () => {
    window.localStorage.setItem(OPT_IN_KEY, 'true');
    const onSelectTopic = vi.fn();
    render(
      <TopicsMode
        topics={topics}
        projects={projects}
        sessions={sessions}
        selectedTopicId={null}
        onSelectTopic={onSelectTopic}
        onSelectSession={() => {}}
      />,
    );
    const disableBtn = screen.getByRole('button', {
      name: /disable topic clustering/i,
    });
    fireEvent.click(disableBtn);
    // Key is cleared and the gate is back.
    expect(window.localStorage.getItem(OPT_IN_KEY)).toBeNull();
    expect(screen.getByText('ENABLE TOPIC CLUSTERING')).toBeDefined();
    // Disable also snaps the topic selection back to null so a stale
    // detail-view doesn't render against the gate next time.
    expect(onSelectTopic).toHaveBeenCalledWith(null);
  });

  it('survives localStorage being unavailable (private mode / policy lock)', () => {
    // Stub localStorage.getItem to throw — the read helper must
    // swallow the error and return false (default-locked).
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error('locked');
    };
    try {
      expect(() =>
        render(
          <TopicsMode
            topics={topics}
            projects={projects}
            sessions={sessions}
            selectedTopicId={null}
            onSelectTopic={() => {}}
            onSelectSession={() => {}}
          />,
        ),
      ).not.toThrow();
      expect(screen.getByText('ENABLE TOPIC CLUSTERING')).toBeDefined();
    } finally {
      window.localStorage.getItem = original;
    }
  });
});
