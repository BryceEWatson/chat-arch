import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-code contract test for empty-state sites on the TODAY page.
//
// We can't render index.astro through experimental_AstroContainer
// because it top-level-await sidecar readers that resolve from
// process.cwd() (see index.astro + readSidecars.ts). The PR #49
// author already documented this limitation at
// test/pages/sidebar-presence.test.ts:13-17. We follow the same
// source-code-assertion approach here — it locks the contract at
// every migration site and runs in node env without harness work.
//
// The principle being enforced (memory:
// feedback_positioning_by_features): empty-states should SHOW the
// loop in motion via demo values, not DESCRIBE it via prose. The
// Phase β feed redesign restructured the page into 5 sections
// (BRIEF / NEW / ACT / BROKEN / STORIES); the AUDIT CONCERNS and
// BLOG DRAFTS rows live INSIDE the BROKEN and STORIES sections now
// as subheads, but the demo-fixture contract is unchanged.

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_ROOT = join(HERE, '..', '..', 'src', 'pages');

function read(rel: string): string {
  return readFileSync(join(PAGES_ROOT, rel), 'utf8');
}

// Extracts the JSX text between an opening { conditional and its
// closing } : (...) — i.e. the first arm of a ternary. Used to
// scope assertions to the empty-state branch of a render.
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  if (start === -1) return '';
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) return src.slice(start);
  return src.slice(start, end);
}

// Count the longest paragraph (by word count) inside a slice. The
// principle's structural invariant: no descriptive paragraph in an
// empty-state. Cap at ≤20 words per <p>; anything above is prose.
// (Phase β raised the cap from 15 → 20 to accommodate the empty-
// state CTA microcopy that now lives next to the REGEN BRIEF / CURATE
// buttons — still well below "explainer paragraph" territory.)
function longestParagraphWords(slice: string): number {
  const matches = [...slice.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)];
  let max = 0;
  for (const m of matches) {
    // Strip JSX expressions {…}, tags, code blocks — count only
    // visible word tokens that contribute to prose feel.
    const cleaned = m[1]
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned === '') continue;
    const words = cleaned.split(' ').length;
    if (words > max) max = words;
  }
  return max;
}

describe('TODAY page (index.astro) — empty-state show-don\'t-describe contract', () => {
  const src = read('index.astro');

  describe('shared infrastructure', () => {
    it('imports from src/lib/demoFixtures', () => {
      // The empty branches should source their demo values from the
      // shared fixture module, not inline literals (per plan decision).
      expect(src).toMatch(/from\s+['"][^'"]*lib\/demoFixtures(\.ts)?['"]/);
    });

    it('does NOT contain the hardcoded {1549} literal', () => {
      // The literal was a stale lie. Replaced with a live derived
      // count (or removed if the count is gone too).
      expect(src).not.toMatch(/\{\s*1549\s*\}/);
    });

    it('renders the 5 Phase-β section bars (BRIEF / NEW / ACT / BROKEN / STORIES)', () => {
      // Each section opens with a today__bar-key carrying the section
      // name. Pin the structure so a future drive-by rename can't
      // silently drop a section. (a11y iter-2 F12: keys promoted from
      // <span> to <h2> for SR heading-outline reachability.)
      for (const key of ['BRIEF', 'NEW', 'ACT', 'BROKEN', 'STORIES']) {
        expect(src).toMatch(
          new RegExp(`<h2 class="today__bar-key"[^>]*>\\{SECTIONS\\[\\d+\\]\\.key\\}|>${key}<`),
        );
      }
    });
  });

  describe('site 1 — ACT section workshop-empty branch', () => {
    // Phase β: the WORKSHOP LOOP hero merged into the ACT section.
    // The empty branch (workshopEmpty, neither scanned nor mined) sits
    // inside the section as a section-with-aria-label demo region.
    const emptyArm = sliceBetween(
      src,
      ') : workshopEmpty ? (',
      ') : (',
    );

    it('renders a .demo-badge element', () => {
      expect(emptyArm).toMatch(/class="[^"]*\bdemo-badge\b/);
    });

    it('wraps the demo region in an aria-labelled section', () => {
      // Privacy/a11y adversary #4: screen readers need an explicit
      // signal that the data shown is demo.
      expect(emptyArm).toMatch(/<section\b[^>]*aria-label="[^"]*[Ee]xample data/);
    });

    it('contains an sr-only span announcing demo context', () => {
      expect(emptyArm).toMatch(/class="[^"]*\bsr-only\b[^"]*">[^<]*[Ee]xample data/);
    });

    it('references the demo workshop count (real metric class)', () => {
      // The empty branch surfaces the demo workshop's unappliedPatternCount
      // through `wsView.unappliedPatternCount` — same data the populated
      // path renders, just sourced from the demo fixture.
      expect(emptyArm).toMatch(/wsView\.unappliedPatternCount/);
    });

    it('has no descriptive paragraph (≤20 words per <p>)', () => {
      expect(longestParagraphWords(emptyArm)).toBeLessThanOrEqual(20);
    });

    it('does NOT contain the old today__empty-note class', () => {
      // The Windows-bug disclaimer paragraph used this class.
      expect(emptyArm).not.toMatch(/today__empty-note/);
    });
  });

  describe('site 2 — STORIES section BLOG DRAFTS subhead empty branch', () => {
    // Phase β: BLOG DRAFTS demoted from its own <h2> row to a <h3>
    // subhead inside the STORIES section. Scope to the subhead through
    // the closing </section> for the STORIES section.
    const sectionStart = src.indexOf('today__stories-subhead">BLOG DRAFTS');
    const sectionEnd = src.indexOf('</section>', sectionStart);
    const section = src.slice(sectionStart, sectionEnd);
    const emptyArm = sliceBetween(section, '? (', ') : (');

    it('renders a .demo-badge element in the empty arm', () => {
      expect(emptyArm).toMatch(/class="[^"]*\bdemo-badge\b/);
    });

    it('renders a demo summary line, not an apology paragraph', () => {
      // Old prose: "No drafts yet. The blog candidate selector ran
      // but produced no drafts because the discoveryScore threshold..."
      expect(emptyArm).not.toMatch(/discoveryScore/);
      expect(emptyArm).not.toMatch(/chat-answer skill/);
    });

    it('has no descriptive paragraph (≤20 words per <p>)', () => {
      expect(longestParagraphWords(emptyArm)).toBeLessThanOrEqual(20);
    });
  });

  describe('site 3 — BROKEN section AUDIT CONCERNS subhead empty branch', () => {
    // Phase β: AUDIT CONCERNS demoted from its own <h2> row to a <h3>
    // subhead inside the BROKEN section. The empty branch is the
    // FIRST ternary after the subhead — scope from the subhead to the
    // <p class="today__row-summary"> that closes it.
    const sectionStart = src.indexOf('today__broken-subhead">AUDIT CONCERNS');
    // The empty-state ternary lives between the subhead and the
    // "full audit table" link. Scope conservatively.
    const sectionEnd = src.indexOf('full audit table', sectionStart);
    const section = src.slice(sectionStart, sectionEnd);
    const emptyArm = sliceBetween(section, '? (', ') : (');

    it('renders a .demo-badge element in the empty arm', () => {
      expect(emptyArm).toMatch(/class="[^"]*\bdemo-badge\b/);
    });

    it('renders the populated today__concerns list shape', () => {
      // Show the concerns list with demo values, not "No F-layer
      // concerns surfaced yet."
      expect(emptyArm).toMatch(/today__concerns/);
    });

    it('SID convention: any demo [SID:...] uses demo prefix', () => {
      // Privacy/a11y adversary #3: real session-ID prefixes from
      // local-transcripts must not leak. Demo SIDs use the sentinel
      // `demo0000-...` prefix; the rendered abbreviation reads
      // `[SID:demo0000…]`.
      const sidMatches = [...emptyArm.matchAll(/SID:([0-9a-f]{8,})/gi)];
      for (const m of sidMatches) {
        expect(m[1].toLowerCase()).toMatch(/^demo/);
      }
      // Also: a stricter form catches any non-demo 8+char hex SID
      // in the slice as a regression guard.
      expect(emptyArm).not.toMatch(/SID:(?!demo)[0-9a-f]{8}/i);
    });

    it('has no descriptive paragraph (≤20 words per <p>)', () => {
      expect(longestParagraphWords(emptyArm)).toBeLessThanOrEqual(20);
    });
  });
});
