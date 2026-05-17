import { describe, it, expect } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';

// BaseLayout wraps every standalone page. With this change, BaseLayout
// hosts the app-wide AppSidebar in a CSS grid alongside the page slot
// — UNLESS the page passes `hideSidebar={true}` (currently only the
// design-system page, which owns its own .lcars-root + walkthrough
// TOC chrome).

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  // @ts-expect-error — Astro components are opaque defaults.
  const BaseLayout = (await import('../../src/layouts/BaseLayout.astro')).default;
  return container.renderToString(BaseLayout, {
    props,
    slots: { default: '<div class="test-slot-marker">SLOT</div>' },
  });
}

describe('BaseLayout — app-wide sidebar host', () => {
  it('renders the AppSidebar by default', async () => {
    const html = await render({ title: 'Test', current: 'TODAY' });
    expect(html).toMatch(/class="[^"]*\bapp-sidebar\b/);
    expect(html).toContain('test-slot-marker');
  });

  it('renders a grid wrapper that hosts the sidebar + main column', async () => {
    const html = await render({ title: 'Test', current: 'TODAY' });
    // Grid wrapper class — assert presence of either explicit class or
    // a data-attribute that the CSS keys on.
    expect(html).toMatch(/class="[^"]*\bapp-shell\b/);
  });

  it('omits the sidebar when hideSidebar={true} (design-system exemption)', async () => {
    const html = await render({ title: 'Design System', hideSidebar: true });
    expect(html).not.toMatch(/class="[^"]*\bapp-sidebar\b/);
    expect(html).toContain('test-slot-marker');
  });

  it('passes the `current` prop through to AppSidebar for active-pill marking', async () => {
    const html = await render({ title: 'Audit', current: 'AUDIT' });
    // The AppSidebar tests assert the aria-current mark; here we just
    // confirm BaseLayout did not lose the prop on its way down. The
    // AUDIT pill anchor carries aria-current=page only when current
    // matches.
    const auditAnchor = html.match(/<a[^>]*href="\/audit"[^>]*>[\s\S]*?AUDIT[\s\S]*?<\/a>/);
    expect(auditAnchor).not.toBeNull();
    expect(auditAnchor?.[0] ?? '').toMatch(/aria-current="page"/);
  });
});
