import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.js';
import { ChatArchViewer } from '../index.js';

function Thrower({ message }: { message: string }): never {
  throw new Error(message);
}

afterEach(() => {
  cleanup();
});

describe('ErrorBoundary (R12 F12.1)', () => {
  beforeEach(() => {
    // React logs boundary-caught errors to console.error; silence for cleaner output.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('renders children normally when no error', () => {
    render(
      <ErrorBoundary>
        <div>child content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('child content')).toBeDefined();
  });

  it('renders the LCARS TRANSMISSION ERROR fallback when children throw', () => {
    render(
      <ErrorBoundary>
        <Thrower message="sync render boom" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/TRANSMISSION ERROR/i)).toBeDefined();
    expect(screen.getByText(/sync render boom/)).toBeDefined();
  });

  it('fallback is wrapped in the LCARS frame (not an unstyled browser default)', () => {
    const { container } = render(
      <ErrorBoundary>
        <Thrower message="any" />
      </ErrorBoundary>,
    );
    expect(container.querySelector('.lcars-root')).toBeTruthy();
    expect(container.querySelector('.lcars-frame')).toBeTruthy();
  });
});

describe('ChatArchViewer manifest ingestion (R12 F12.1)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('routes a bare-array manifest (`[]`) to the TRANSMISSION ERROR state, not a blank page', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [],
        }) as unknown as Response,
    );
    render(<ChatArchViewer manifestUrl="/bad.json" />);
    await waitFor(() => expect(screen.getByText(/TRANSMISSION ERROR/i)).toBeDefined());
    expect(screen.getByText(/sessions/i)).toBeDefined();
  });

  it('renders UC-8 NO SESSIONS for a well-formed empty manifest', () => {
    const empty = {
      schemaVersion: 1 as const,
      generatedAt: 0,
      counts: { cloud: 0, cowork: 0, 'cli-direct': 0, 'cli-desktop': 0 } as const,
      sessions: [] as const,
    };
    render(<ChatArchViewer manifest={empty} />);
    expect(screen.getByText('NO SESSIONS')).toBeDefined();
  });
});
