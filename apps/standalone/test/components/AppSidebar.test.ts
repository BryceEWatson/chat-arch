import { describe, it, expect, beforeAll } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

// Renders AppSidebar.astro and asserts the static markup contract:
// group order, TODAY position, DATA href, aria-current, short codes,
// group labels. Plain string / regex assertions — keeps the standalone
// test env at `environment: 'node'` (no JSDOM).

let html: string;
let htmlOnAudit: string;

beforeAll(async () => {
  const container = await AstroContainer.create();
  // @ts-expect-error — Astro components are typed as default exports
  // of an opaque component, fine at runtime.
  const AppSidebar = (await import('../../src/components/AppSidebar.astro')).default;
  html = await container.renderToString(AppSidebar, { props: { current: 'TODAY' } });
  htmlOnAudit = await container.renderToString(AppSidebar, { props: { current: 'AUDIT' } });
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

  it('renders the four group labels in order: WORKSHOP, TRACK, BROWSE, SYSTEM', () => {
    const labels = [...html.matchAll(/app-sidebar__group-label[^>]*>([^<]+)</g)].map((m) =>
      m[1].trim(),
    );
    expect(labels).toEqual(['WORKSHOP', 'TRACK', 'BROWSE', 'SYSTEM']);
  });

  it('does not include TODAY inside the TRACK group', () => {
    // TODAY lives ABOVE the groups, not inside TRACK. Extract the TRACK
    // group slice and assert TODAY is not in it.
    const trackIx = html.indexOf('>TRACK<');
    expect(trackIx).toBeGreaterThan(-1);
    // Slice from TRACK label to the next group label (BROWSE).
    const browseIx = html.indexOf('>BROWSE<', trackIx);
    expect(browseIx).toBeGreaterThan(trackIx);
    const trackSlice = html.slice(trackIx, browseIx);
    expect(trackSlice).not.toContain('TODAY');
    expect(trackSlice).toContain('AUDIT');
    expect(trackSlice).toContain('HEALTH');
    expect(trackSlice).toContain('DRAFTS');
  });

  it('renders WORKSHOP items in order: CHAT, CORRECTIONS, PRACTICE', () => {
    const ws = html.indexOf('>WORKSHOP<');
    const tr = html.indexOf('>TRACK<');
    const slice = html.slice(ws, tr);
    const ixChat = slice.indexOf('CHAT');
    const ixCor = slice.indexOf('CORRECTIONS');
    const ixPrc = slice.indexOf('PRACTICE');
    expect(ixChat).toBeGreaterThan(-1);
    expect(ixCor).toBeGreaterThan(ixChat);
    expect(ixPrc).toBeGreaterThan(ixCor);
  });

  it('renders BROWSE items in order: SESSIONS, PROJECTS, TOPICS', () => {
    const br = html.indexOf('>BROWSE<');
    const sy = html.indexOf('>SYSTEM<');
    const slice = html.slice(br, sy);
    const a = slice.indexOf('SESSIONS');
    const b = slice.indexOf('PROJECTS');
    const c = slice.indexOf('TOPICS');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('renders SYSTEM items: DESIGN SYSTEM then DATA', () => {
    const sy = html.indexOf('>SYSTEM<');
    const slice = html.slice(sy);
    const a = slice.indexOf('DESIGN SYSTEM');
    const b = slice.indexOf('DATA');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it('CHAT and CORRECTIONS link into the viewer via /sessions hash routes', () => {
    expect(html).toMatch(/href="\/sessions#chat"/);
    expect(html).toMatch(/href="\/sessions#corrections"/);
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

  it('marks current=AUDIT with aria-current=page on the AUDIT pill, not TODAY', () => {
    const auditAnchor = htmlOnAudit.match(/<a[^>]*href="\/audit"[^>]*>[\s\S]*?AUDIT[\s\S]*?<\/a>/);
    expect(auditAnchor).not.toBeNull();
    expect(auditAnchor?.[0] ?? '').toMatch(/aria-current="page"/);
    const todayAnchor = htmlOnAudit.match(/<a[^>]*href="\/"[^>]*>[\s\S]*?TODAY[\s\S]*?<\/a>/);
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
