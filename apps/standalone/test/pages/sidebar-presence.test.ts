import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-code contract test. The 8 pages that previously rendered
// <TodayNav current="…" /> must instead pass `current=` to BaseLayout
// (which now hosts the app-wide AppSidebar) and must NOT import the
// retired TodayNav component. The design-system page is exempt: it
// passes hideSidebar={true} so BaseLayout skips the sidebar entirely
// (it has its own .lcars-root walkthrough chrome).
//
// Rendering each page through experimental_AstroContainer would couple
// the test to the sidecar loaders + getStaticPaths machinery, which is
// brittle on a clean clone where analysis/*.json doesn't exist. The
// source-code assertion is the right cut: it catches every migration
// site and locks the contract.

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_ROOT = join(HERE, '..', '..', 'src', 'pages');

interface PageCase {
  /** Path relative to apps/standalone/src/pages */
  file: string;
  /** Expected `current=` prop value passed to BaseLayout (raw, without quotes). */
  current: string;
}

const PAGES: PageCase[] = [
  { file: 'index.astro', current: 'TODAY' },
  { file: 'audit.astro', current: 'AUDIT' },
  { file: 'health.astro', current: 'HEALTH' },
  { file: 'blog-drafts/index.astro', current: 'DRAFTS' },
  { file: 'blog-drafts/[slug].astro', current: 'DRAFTS' },
  { file: 'sessions.astro', current: 'SESSIONS' },
  { file: 'projects.astro', current: 'PROJECTS' },
  { file: 'topics.astro', current: 'TOPICS' },
  { file: 'practice.astro', current: 'PRACTICE' },
  { file: 'personas.astro', current: 'PERSONAS' },
];

function read(rel: string): string {
  return readFileSync(join(PAGES_ROOT, rel), 'utf8');
}

describe('page → sidebar migration contract', () => {
  for (const { file, current } of PAGES) {
    describe(file, () => {
      const src = read(file);

      it('does NOT import the retired TodayNav component', () => {
        expect(src).not.toMatch(/from\s+['"][^'"]*TodayNav[^'"]*['"]/);
        expect(src).not.toMatch(/<\s*TodayNav\b/);
      });

      it(`passes current="${current}" to BaseLayout`, () => {
        // Allow either current="…" (string literal) or current={…}
        // (expression) — both forms reach BaseLayout the same way.
        const re = new RegExp(
          `<\\s*BaseLayout[^>]*current=(?:"${current}"|{['"]${current}['"]})`,
          's',
        );
        expect(src).toMatch(re);
      });
    });
  }

  it('design-system/index.astro passes hideSidebar={true} (or boolean shorthand)', () => {
    const src = read('design-system/index.astro');
    expect(src).toMatch(/<\s*BaseLayout[^>]*hideSidebar(?:={true}|=\{true\}|\s|>)/s);
  });
});
