import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

// Renders AppSidebar.astro and asserts the static markup contract:
// group order, TODAY position, DATA href, aria-current, short codes,
// group labels. Plain string / regex assertions — keeps the standalone
// test env at `environment: 'node'` (no JSDOM).

let html: string;
let htmlOnSessions: string;

beforeAll(async () => {
  const container = await AstroContainer.create();
  // @ts-expect-error — Astro components are typed as default exports
  // of an opaque component, fine at runtime.
  const AppSidebar = (await import('../../src/components/AppSidebar.astro')).default;
  html = await container.renderToString(AppSidebar, { props: { current: 'TODAY' } });
  htmlOnSessions = await container.renderToString(AppSidebar, { props: { current: 'SESSIONS' } });
});

describe('AppSidebar — render contract', () => {
  it('renders the .app-sidebar root element', () => {
    expect(html).toMatch(/class="[^"]*\bapp-sidebar\b/);
  });

  it('renders TODAY inside .app-sidebar__top (above the groups)', () => {
    // TODAY must appear inside a __top wrapper that comes BEFORE any
    // __group wrapper. We check the order by index — a positive index
    // for top, a later index for the first group, and the TODAY label
    // sits inside the top section.
    const topIx = html.indexOf('app-sidebar__top');
    const firstGroupIx = html.indexOf('app-sidebar__group');
    expect(topIx).toBeGreaterThan(-1);
    expect(firstGroupIx).toBeGreaterThan(topIx);
    const topSlice = html.slice(topIx, firstGroupIx);
    expect(topSlice).toContain('TODAY');
    expect(topSlice).toContain('TDY');
  });

  it('renders the divider between TODAY and the first group', () => {
    const dividerIx = html.indexOf('app-sidebar__divider');
    const firstGroupIx = html.indexOf('app-sidebar__group');
    expect(dividerIx).toBeGreaterThan(-1);
    expect(firstGroupIx).toBeGreaterThan(dividerIx);
  });

  it('renders the three group labels in order: ARCHIVE, WORKSHOP, SYSTEM', () => {
    const labels = [...html.matchAll(/app-sidebar__group-label[^>]*>([^<]+)</g)].map((m) =>
      m[1].trim(),
    );
    expect(labels).toEqual(['ARCHIVE', 'WORKSHOP', 'SYSTEM']);
  });

  it('renders ARCHIVE items in order: SESSIONS, PROJECTS, TOPICS', () => {
    const ar = html.indexOf('>ARCHIVE<');
    const ws = html.indexOf('>WORKSHOP<');
    expect(ar).toBeGreaterThan(-1);
    expect(ws).toBeGreaterThan(ar);
    const slice = html.slice(ar, ws);
    const a = slice.indexOf('SESSIONS');
    const b = slice.indexOf('PROJECTS');
    const c = slice.indexOf('TOPICS');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('renders WORKSHOP items in order: PLAYBOOK, CORRECTIONS, PRACTICE', () => {
    const ws = html.indexOf('>WORKSHOP<');
    const sy = html.indexOf('>SYSTEM<');
    const slice = html.slice(ws, sy);
    const ixPlb = slice.indexOf('PLAYBOOK');
    const ixCor = slice.indexOf('CORRECTIONS');
    const ixPrc = slice.indexOf('PRACTICE');
    expect(ixPlb).toBeGreaterThan(-1);
    expect(ixCor).toBeGreaterThan(ixPlb);
    expect(ixPrc).toBeGreaterThan(ixCor);
  });

  it('renders SYSTEM items in order: HEALTH, CALIBRATE, ALL VIEWS, DESIGN SYSTEM, DATA', () => {
    const sy = html.indexOf('>SYSTEM<');
    const slice = html.slice(sy);
    const ixHlt = slice.indexOf('HEALTH');
    const ixCal = slice.indexOf('CALIBRATE');
    const ixVws = slice.indexOf('ALL VIEWS');
    const ixDsy = slice.indexOf('DESIGN SYSTEM');
    const ixDat = slice.indexOf('>DATA<');
    expect(ixHlt).toBeGreaterThan(-1);
    expect(ixCal).toBeGreaterThan(ixHlt);
    expect(ixVws).toBeGreaterThan(ixCal);
    expect(ixDsy).toBeGreaterThan(ixVws);
    expect(ixDat).toBeGreaterThan(ixDsy);
  });

  it('drops the CHAT, AUDIT, DRAFTS, RESULTS sidebar entries (folded into FEED)', () => {
    // The labels live on the cards themselves now, not in the sidebar.
    // Use anchored matches against the sidebar __item-label span to
    // avoid false hits on substring overlaps (e.g. CORRECTIONS would
    // match a naive /CHAT/ probe).
    const sidebarLabels = [...html.matchAll(
      /app-sidebar__item-label[^>]*>([^<]+)</g,
    )].map((m) => m[1].trim());
    expect(sidebarLabels).not.toContain('CHAT');
    expect(sidebarLabels).not.toContain('AUDIT');
    expect(sidebarLabels).not.toContain('DRAFTS');
    expect(sidebarLabels).not.toContain('RESULTS');
  });

  it('CORRECTIONS still links into the viewer via /sessions hash route', () => {
    expect(html).toMatch(/href="\/sessions#corrections"/);
  });

  it('ALL VIEWS pill links to the /views escape-hatch catalogue', () => {
    expect(html).toMatch(/href="\/views"/);
  });

  it('DATA pill links to /sessions#data and is never aria-current=page', () => {
    expect(html).toMatch(/href="\/sessions#data"/);
    // Extract just the DATA anchor and assert it does not carry aria-current=page.
    const dataMatch = html.match(/<a[^>]*href="\/sessions#data"[^>]*>/);
    expect(dataMatch).not.toBeNull();
    expect(dataMatch?.[0] ?? '').not.toMatch(/aria-current="page"/);
  });

  it('marks current=TODAY with aria-current=page on the TODAY pill', () => {
    // Find the TODAY anchor (href="/") and assert aria-current=page is present.
    // Look for an <a> tag that wraps TODAY content.
    const todayAnchorMatch = html.match(/<a[^>]*href="\/"[^>]*>[\s\S]*?TODAY[\s\S]*?<\/a>/);
    expect(todayAnchorMatch).not.toBeNull();
    expect(todayAnchorMatch?.[0] ?? '').toMatch(/aria-current="page"/);
  });

  it('marks current=SESSIONS with aria-current=page on the SESSIONS pill, not TODAY', () => {
    const sessionsAnchor = htmlOnSessions.match(
      /<a[^>]*href="\/sessions"[^>]*>[\s\S]*?SESSIONS[\s\S]*?<\/a>/,
    );
    expect(sessionsAnchor).not.toBeNull();
    expect(sessionsAnchor?.[0] ?? '').toMatch(/aria-current="page"/);
    const todayAnchor = htmlOnSessions.match(
      /<a[^>]*href="\/"[^>]*>[\s\S]*?TODAY[\s\S]*?<\/a>/,
    );
    expect(todayAnchor?.[0] ?? '').not.toMatch(/aria-current="page"/);
  });

  it('uses the TODAY full-sunflower visual treatment class', () => {
    // The TODAY pill is in a top section using the full sunflower bg
    // (not -muted). We assert the class hook is present in the top slice.
    const topIx = html.indexOf('app-sidebar__top');
    const firstGroupIx = html.indexOf('app-sidebar__group');
    const topSlice = html.slice(topIx, firstGroupIx);
    expect(topSlice).toMatch(/app-sidebar__today/);
  });

  it('renders a footer with a VIEW SOURCE / repo link (trust real-estate)', () => {
    // Sidebar.tsx in the viewer had a footer RepoLink chip; without one
    // here, drive-by visitors (Priya) and trust-checkers (David) lose
    // the "view source to verify" affordance the moment they leave the
    // empty-state TrustStrip on /. Anchor it in the sidebar so it's
    // always reachable.
    const footerIx = html.indexOf('app-sidebar__footer');
    expect(footerIx).toBeGreaterThan(-1);
    const footerSlice = html.slice(footerIx);
    expect(footerSlice).toMatch(/href="https:\/\/github\.com\/BryceEWatson\/chat-arch"/);
    // Either VIEW SOURCE or SOURCE — whichever the chip uses, ensure
    // the user-visible text exists.
    expect(footerSlice).toMatch(/SOURCE/);
  });

  it('renders a collapse toggle button with keyboard semantics', () => {
    expect(html).toMatch(/class="[^"]*app-sidebar__toggle/);
    // Either a real <button> or role=button + tabindex=0.
    expect(html).toMatch(/(<button[^>]*app-sidebar__toggle)|(role="button"[^>]*tabindex="0"[^>]*app-sidebar__toggle)|(app-sidebar__toggle[^>]*role="button"[^>]*tabindex="0")|(app-sidebar__toggle[^>]*tabindex="0")/);
    // aria-expanded mirrors the collapsed state — expanded by default.
    expect(html).toMatch(/aria-expanded="true"/);
  });
});
