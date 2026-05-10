import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { LastIndexedChip } from './LastIndexedChip.js';

afterEach(() => cleanup());

const MS_PER_DAY = 86_400_000;
// Fixed "now" so the test isn't time-dependent. Picked an arbitrary
// 2026-05-08 noon UTC.
const NOW = Date.parse('2026-05-08T12:00:00Z');

describe('LastIndexedChip', () => {
  it('renders nothing when generatedAt is null', () => {
    const { container } = render(<LastIndexedChip generatedAt={null} now={NOW} />);
    expect(container.querySelector('.lcars-top-bar__indexed')).toBeNull();
  });

  it('shows INDEXED TODAY for a fresh manifest', () => {
    const { container } = render(
      <LastIndexedChip generatedAt={NOW - 2 * 60 * 60 * 1000} now={NOW} />,
    );
    const chip = container.querySelector('.lcars-top-bar__indexed');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('INDEXED TODAY');
    // No stale attribute when fresh.
    expect(chip!.hasAttribute('data-stale')).toBe(false);
  });

  it('shows day count and no stale flag at 5 days', () => {
    const { container } = render(
      <LastIndexedChip generatedAt={NOW - 5 * MS_PER_DAY} now={NOW} />,
    );
    const chip = container.querySelector('.lcars-top-bar__indexed');
    expect(chip!.textContent).toContain('INDEXED 5d AGO');
    expect(chip!.hasAttribute('data-stale')).toBe(false);
  });

  it('flips to stale at 31 days', () => {
    const { container } = render(
      <LastIndexedChip generatedAt={NOW - 31 * MS_PER_DAY} now={NOW} />,
    );
    const chip = container.querySelector('.lcars-top-bar__indexed');
    expect(chip!.textContent).toContain('INDEXED 31d AGO');
    expect(chip!.hasAttribute('data-stale')).toBe(true);
  });

  it('renders nothing when generatedAt is 0 (epoch zero treated as no real timestamp)', () => {
    // A half-initialized manifest (or a parser bug) writing
    // generatedAt: 0 would otherwise produce "INDEXED 20000d AGO" — a
    // misleading staleness signal. Treat <=0 as "no timestamp" and
    // hide the chip.
    const { container } = render(<LastIndexedChip generatedAt={0} now={NOW} />);
    expect(container.querySelector('.lcars-top-bar__indexed')).toBeNull();
  });

  it('clamps future generatedAt to INDEXED TODAY (clock-skew tolerance)', () => {
    // A user whose clock is behind the build host's clock would see
    // generatedAt > now. Without the clamp the chip would render
    // "INDEXED -1d AGO" — a parsing artifact, not a real signal.
    // Floor elapsed days at 0 and degrade gracefully to today.
    const { container } = render(
      <LastIndexedChip generatedAt={NOW + MS_PER_DAY} now={NOW} />,
    );
    const chip = container.querySelector('.lcars-top-bar__indexed');
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain('INDEXED TODAY');
    expect(chip!.hasAttribute('data-stale')).toBe(false);
  });

  it('tooltip contains the ISO timestamp and the UPDATE LOCAL CTA', () => {
    const generatedAt = NOW - 5 * MS_PER_DAY;
    const { container } = render(
      <LastIndexedChip generatedAt={generatedAt} now={NOW} />,
    );
    const chip = container.querySelector('.lcars-top-bar__indexed') as HTMLElement;
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain(new Date(generatedAt).toISOString());
    expect(title).toContain('UPDATE LOCAL');
  });
});
