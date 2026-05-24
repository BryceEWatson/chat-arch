import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportMode } from './ExportMode.js';
import type { ExportManifest } from '../../data/exportsLoader.js';

/**
 * ExportMode tests (Stream J #7):
 *   - Checklist renders four kinds.
 *   - GENERATE is disabled until a kind is selected.
 *   - Mock the fetch path → GENERATE flips through running → done.
 *   - Empty / no-endpoint state surfaces helpfully.
 */

const manifest: ExportManifest = {
  manifestVersion: 1,
  generatedAt: new Date(0).toISOString(),
  entries: [
    {
      id: 'session-1',
      kind: 'post-mortem',
      relativePath: 'exports/post-mortems/session-1.md',
      generatedAt: new Date(0).toISOString(),
      title: 'Post-mortem',
    },
    {
      id: 'topic-foo',
      kind: 'knowledge-debt',
      relativePath: 'exports/knowledge-debt/foo.md',
      generatedAt: new Date(0).toISOString(),
    },
  ],
};

const realFetch = globalThis.fetch;

beforeEach(() => {
  // Stub fetch: the probe (GET) returns ok=true; the POST returns a
  // structured success payload. Per-test cases override as needed.
  globalThis.fetch = vi.fn(async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      return new Response(
        JSON.stringify({ ok: true, outputDir: '/tmp/exports', count: 4 }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe('ExportMode', () => {
  it('renders the four export-kind checkboxes', () => {
    render(<ExportMode manifest={manifest} />);
    expect(screen.getByTestId('kind-post-mortem')).toBeDefined();
    expect(screen.getByTestId('kind-knowledge-debt')).toBeDefined();
    expect(screen.getByTestId('kind-decision-log')).toBeDefined();
    expect(screen.getByTestId('kind-trust-report')).toBeDefined();
  });

  it('reports per-kind counts from the manifest', () => {
    render(<ExportMode manifest={manifest} />);
    // post-mortem kind row should report a count of 1.
    const postMortemLabel = screen
      .getByTestId('kind-post-mortem')
      .closest('label')!;
    expect(postMortemLabel.textContent).toContain('1');
  });

  it('disables the GENERATE button until at least one kind is selected', () => {
    render(<ExportMode manifest={{ ...manifest, entries: [] }} />);
    const btn = screen.getByTestId('generate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('kind-post-mortem'));
    expect(btn.disabled).toBe(false);
  });

  it('cycles through the running → done states on the mock generate flow', async () => {
    render(<ExportMode manifest={manifest} />);
    // Manifest with existing entries auto-selects the matching kinds.
    const btn = screen.getByTestId('generate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    // GENERATING… caption flashes; on success the result panel shows.
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Generated/),
    );
    expect(screen.getByText('/tmp/exports')).toBeDefined();
    expect(screen.getByTestId('open-output-btn')).toBeDefined();
  });

  it('shows an error surface when generation fails', async () => {
    globalThis.fetch = vi.fn(async (_input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        return new Response('disk full', { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<ExportMode manifest={manifest} />);
    fireEvent.click(screen.getByTestId('generate-btn'));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(
        /Generation failed/,
      ),
    );
  });
});
