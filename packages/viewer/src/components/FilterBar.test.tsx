import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SessionManifest, UnifiedSessionEntry } from '@chat-arch/schema';
import { FilterBar } from './FilterBar.js';

function entry(id: string, overrides: Partial<UnifiedSessionEntry> = {}): UnifiedSessionEntry {
  return {
    id,
    source: 'cloud',
    rawSessionId: id,
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    title: `T ${id}`,
    titleSource: 'cloud-name',
    preview: null,
    userTurns: 1,
    model: null,
    cwdKind: 'none',
    totalCostUsd: null,
    ...overrides,
  } as UnifiedSessionEntry;
}

function manifest(entries: UnifiedSessionEntry[]): SessionManifest {
  return {
    schemaVersion: 2,
    generatedAt: 0,
    counts: {
      cloud: entries.filter((e) => e.source === 'cloud').length,
      cowork: entries.filter((e) => e.source === 'cowork').length,
      'cli-direct': entries.filter((e) => e.source === 'cli-direct').length,
      'cli-desktop': entries.filter((e) => e.source === 'cli-desktop').length,
    },
    sessions: entries,
  };
}

const base = {
  sourceFilter: new Set<UnifiedSessionEntry['source']>(),
  onToggleSource: () => {},
  onClearFilters: () => {},
  projectFilter: new Set<string>(),
  onToggleProject: () => {},
  unknownProjectActive: false,
  onToggleUnknownProject: () => {},
  showEmpty: false,
  onToggleShowEmpty: () => {},
};

describe('FilterBar project pills (AC12)', () => {
  it('renders up to 8 project pills + UNKNOWN + rest-collapse', () => {
    const entries: UnifiedSessionEntry[] = [];
    for (let i = 0; i < 10; i += 1) entries.push(entry(`p${i}`, { project: `proj${i}` }));
    entries.push(entry('u1'), entry('u2'), entry('u3'));
    render(<FilterBar manifest={manifest(entries)} filtered={entries} {...base} />);
    expect(screen.getByText('UNKNOWN')).toBeDefined();
    const unknownPill = screen.getByText('UNKNOWN').closest('[role="button"]')!;
    expect(unknownPill.querySelector('.lcars-project-pill__count')!.textContent).toBe('3');
    expect(screen.getByText(/\+2 more/)).toBeDefined();
  });

  it('UNKNOWN pill click fires onToggleUnknownProject', () => {
    const onToggle = vi.fn();
    const entries = [entry('a'), entry('b', { project: 'alpha' })];
    render(
      <FilterBar
        manifest={manifest(entries)}
        filtered={entries}
        {...base}
        onToggleUnknownProject={onToggle}
      />,
    );
    fireEvent.click(screen.getByText('UNKNOWN').closest('[role="button"]')!);
    expect(onToggle).toHaveBeenCalled();
  });

  it('project pill click fires onToggleProject(id)', () => {
    const onToggleProject = vi.fn();
    const entries = [entry('a', { project: 'alpha' })];
    const { container } = render(
      <FilterBar
        manifest={manifest(entries)}
        filtered={entries}
        {...base}
        onToggleProject={onToggleProject}
      />,
    );
    const pill = container.querySelector(
      '.lcars-project-pill:not(.lcars-project-pill--unknown):not(.lcars-project-pill--rest)',
    ) as HTMLElement;
    expect(pill).not.toBeNull();
    fireEvent.click(pill);
    expect(onToggleProject).toHaveBeenCalledWith('alpha');
  });
});

describe('FilterBar dual-dimension pills (project + topic)', () => {
  it('counts projects and topics independently — a session with BOTH contributes to each row', () => {
    // Core invariant of the dual-label model: `session.project` and
    // `session.topic` are separate axes. A session tagged
    // project=py-coder AND topic=~performance should add 1 to each
    // row's pill, not just one of them.
    const entries = [
      entry('a', { project: 'py-coder', topic: '~performance' }),
      entry('b', { project: 'py-coder' }), // project only
      entry('c', { topic: '~performance' }), // topic only
      entry('d', { project: 'py-coder', topic: '~performance' }),
      entry('e'), // neither → UNKNOWN on projects axis
    ];
    const { container } = render(
      <FilterBar manifest={manifest(entries)} filtered={entries} {...base} />,
    );

    // py-coder pill: 3 sessions (a, b, d)
    const namedPills = container.querySelectorAll(
      '.lcars-project-pill:not(.lcars-project-pill--unknown):not(.lcars-project-pill--emergent):not(.lcars-project-pill--rest)',
    );
    const pyCoder = [...namedPills].find((p) => p.textContent?.includes('py-coder'))!;
    expect(pyCoder.querySelector('.lcars-project-pill__count')!.textContent).toBe('3');

    // UNKNOWN: 2 sessions (c, e — both lack s.project)
    const unknown = screen.getByText('UNKNOWN').closest('[role="button"]')!;
    expect(unknown.querySelector('.lcars-project-pill__count')!.textContent).toBe('2');

    // ~performance topic pill: 3 sessions (a, c, d)
    const topicPills = container.querySelectorAll('.lcars-project-pill--emergent');
    expect(topicPills).toHaveLength(1);
    const perfPill = topicPills[0]!;
    expect(perfPill.textContent).toContain('performance');
    expect(perfPill.querySelector('.lcars-project-pill__count')!.textContent).toBe('3');
  });

  it('project row + UNKNOWN sum to sessions.length (partition invariant)', () => {
    const entries = [
      entry('a', { project: 'alpha' }),
      entry('b', { project: 'alpha', topic: '~x' }),
      entry('c', { project: 'beta' }),
      entry('d', { topic: '~x' }), // UNKNOWN project, topic=~x
      entry('e'), // UNKNOWN, no topic
    ];
    const { container } = render(
      <FilterBar manifest={manifest(entries)} filtered={entries} {...base} />,
    );

    const namedPills = container.querySelectorAll(
      '.lcars-project-pill:not(.lcars-project-pill--unknown):not(.lcars-project-pill--emergent):not(.lcars-project-pill--rest)',
    );
    const namedSum = [...namedPills].reduce(
      (acc, p) => acc + Number(p.querySelector('.lcars-project-pill__count')!.textContent ?? '0'),
      0,
    );
    const unknownCount = Number(
      screen
        .getByText('UNKNOWN')
        .closest('[role="button"]')!
        .querySelector('.lcars-project-pill__count')!.textContent ?? '0',
    );
    expect(namedSum + unknownCount).toBe(entries.length);
  });

  it('hides UNKNOWN pill when count is 0 AND not actively filtering on it', () => {
    // Every session has a project — nothing falls into UNKNOWN.
    const entries = [
      entry('a', { project: 'alpha' }),
      entry('b', { project: 'beta' }),
    ];
    render(<FilterBar manifest={manifest(entries)} filtered={entries} {...base} />);
    expect(screen.queryByText('UNKNOWN')).toBeNull();
  });

  it('keeps UNKNOWN pill visible when actively filtering on it (so user can un-toggle)', () => {
    // Simulates the state right after the user clicked UNKNOWN and
    // then also clicked a topic that leaves 0 UNKNOWN sessions. If
    // we hid the pill in this state the user couldn't un-click it.
    const entries = [
      entry('a', { project: 'alpha', topic: '~x' }),
      entry('b', { project: 'beta' }),
    ];
    render(
      <FilterBar
        manifest={manifest(entries)}
        filtered={entries}
        {...base}
        unknownProjectActive={true}
      />,
    );
    expect(screen.getByText('UNKNOWN')).toBeDefined();
  });

  it('does not render the topics row when no session has a topic', () => {
    const entries = [entry('a', { project: 'alpha' }), entry('b')];
    const { container } = render(
      <FilterBar manifest={manifest(entries)} filtered={entries} {...base} />,
    );
    const topicRow = container.querySelector('.lcars-filter-bar__pills--topic');
    expect(topicRow).toBeNull();
  });
});

describe('FilterBar zero-turn toggle (AC11)', () => {
  it('renders the SHOW EMPTY (N) button with the correct count', () => {
    const entries = [
      entry('z1', { userTurns: 0 }),
      entry('z2', { userTurns: 0 }),
      entry('a', { userTurns: 3 }),
    ];
    render(<FilterBar manifest={manifest(entries)} filtered={[entries[2]!]} {...base} />);
    const toggle = document.querySelector('.lcars-zero-turn-toggle');
    expect(toggle?.textContent).toContain('SHOW EMPTY');
    expect(toggle?.textContent).toContain('2');
  });

  it('renders HIDE EMPTY when showEmpty=true', () => {
    const entries = [entry('z', { userTurns: 0 }), entry('a', { userTurns: 1 })];
    render(
      <FilterBar manifest={manifest(entries)} filtered={entries} {...base} showEmpty={true} />,
    );
    const toggle = document.querySelector('.lcars-zero-turn-toggle');
    expect(toggle?.textContent).toContain('HIDE EMPTY');
    expect(toggle?.textContent).toContain('1');
  });

  it('calls onToggleShowEmpty on click', () => {
    const onToggle = vi.fn();
    const entries = [entry('a')];
    render(
      <FilterBar
        manifest={manifest(entries)}
        filtered={entries}
        {...base}
        onToggleShowEmpty={onToggle}
      />,
    );
    fireEvent.click(document.querySelector('.lcars-zero-turn-toggle')!);
    expect(onToggle).toHaveBeenCalled();
  });
});
