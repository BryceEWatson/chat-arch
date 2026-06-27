import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type * as CuratorFeedClient from '../data/curatorFeedClient.js';

/**
 * CuratorFeed tests — scaffold-disclosure contract (issue #120).
 *
 * The curator ranker / falsifier / meta-validation kernels are not yet
 * wired into a production path, so any `falsifierStatus` tag is a
 * placeholder. The surface must (a) carry a standing scaffold disclaimer,
 * (b) NOT assert "passed the falsifier" as fact, and (c) render any
 * falsifier tag as a placeholder rather than an affirmative verdict.
 */

const mockLoad = vi.fn();
vi.mock('../data/curatorFeedClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CuratorFeedClient>();
  return {
    ...actual,
    loadCuratorFeed: () => mockLoad(),
  };
});

import { CuratorFeed } from './CuratorFeed.js';
import type { CuratorFeedFile } from '../data/curatorFeedClient.js';

afterEach(() => {
  cleanup();
  mockLoad.mockReset();
});

describe('CuratorFeed — scaffold disclosure (issue #120)', () => {
  it('shows a standing scaffold disclaimer (curator/falsifier not wired to production)', async () => {
    mockLoad.mockResolvedValue(null);
    render(<CuratorFeed />);
    const note = await screen.findByTestId('curator-scaffold-note');
    expect(note.textContent).toMatch(/scaffold/i);
    expect(note.textContent).toMatch(/placeholders, not real verdicts/i);
  });

  it('does not assert "passed the falsifier" as fact while the pipeline is a scaffold', async () => {
    mockLoad.mockResolvedValue(null);
    render(<CuratorFeed />);
    await screen.findByTestId('curator-scaffold-note');
    expect(screen.queryByText(/passed the falsifier/i)).toBeNull();
  });

  it('renders a falsifierStatus tag as a placeholder, not an affirmative verdict', async () => {
    const feed: CuratorFeedFile = {
      schemaVersion: 1,
      generatedAt: 1,
      ranAt: '2026-01-01T00:00:00.000Z',
      items: [
        {
          kind: 'narrative',
          entityId: 'nar_1',
          title: 'Some narrative',
          rank: 1,
          compositeScore: 0.9,
          falsifierStatus: 'verified',
        },
      ],
    };
    mockLoad.mockResolvedValue(feed);
    render(<CuratorFeed />);
    const tag = await screen.findByLabelText(/falsifier verified \(placeholder/i);
    expect(tag.textContent).toMatch(/\(placeholder\)/);
    expect(tag.className).toMatch(/--placeholder/);
  });
});
