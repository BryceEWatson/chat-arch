import { test, expect, type Page } from '@playwright/test';

/**
 * v2 spec §5 + §11: structural visual coverage of every top-level
 * surface (PROJECTS / TOPICS / SESSIONS / PRACTICE) plus the chrome
 * (TopBar + sidebar + DATA panel). Each test asserts on stable DOM
 * shape (class names, count of pills, presence of section titles)
 * rather than pixel-equal screenshots — see playwright.config.ts
 * for the rationale.
 *
 * The required-states matrix from spec §11 (Empty / Loading / Error
 * / Browser-tier-restricted) is exercised only at the level the
 * single suite can reach: empty-state rendering when the manifest
 * is empty, and disabled-with-explanation for narrative actions in
 * browser-tier (probe returns false).
 */

async function loadDemo(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  const demoBtn = page.getByRole('button', { name: /load demo data/i });
  if (await demoBtn.count()) {
    await demoBtn.first().click();
    // Wait for the populated viewer to mount: sidebar PROJECTS item
    // is the cheapest sentinel.
    await page.locator('[role="button"][aria-label*="mode PROJECTS"]').first().waitFor();
  }
}

test.describe('Chrome (TopBar + Sidebar + DATA panel)', () => {
  test('TopBar is informational — no source-buttons (spec §6 / D4)', async ({ page }) => {
    await loadDemo(page);
    const headerSourceBtns = await page
      .locator('.lcars-top-bar .lcars-top-bar__source-btn')
      .count();
    expect(headerSourceBtns).toBe(0);
    await expect(page.locator('.lcars-top-bar__earthdate')).toHaveCount(1);
    await expect(page.locator('.lcars-top-bar__location')).toHaveCount(1);
  });

  test('Sidebar exposes the v2 surfaces (no TIMELINE)', async ({ page }) => {
    await loadDemo(page);
    // BROWSE
    await expect(page.locator('[role="button"][aria-label*="mode PROJECTS"]')).toHaveCount(1);
    await expect(page.locator('[role="button"][aria-label*="mode TOPICS"]')).toHaveCount(1);
    await expect(page.locator('[role="button"][aria-label*="mode SESSIONS"]')).toHaveCount(1);
    // INSIGHTS
    await expect(page.locator('[role="button"][aria-label*="mode PRACTICE"]')).toHaveCount(1);
    await expect(page.locator('[role="button"][aria-label*="mode ANALYSIS"]')).toHaveCount(1);
    await expect(page.locator('[role="button"][aria-label*="mode COST"]')).toHaveCount(1);
    // ACTIONS
    await expect(page.locator('[role="button"][aria-label*="open DATA panel"]')).toHaveCount(1);
    // Retired
    await expect(page.locator('[role="button"][aria-label*="mode TIMELINE"]')).toHaveCount(0);
  });

  test('DATA panel opens and closes from the sidebar trigger', async ({ page }) => {
    await loadDemo(page);
    await page.locator('[role="button"][aria-label*="open DATA panel"]').click();
    await expect(page.locator('.lcars-data-panel')).toBeVisible();
    // Sections render even when scan/upload availability differs.
    await expect(page.locator('.lcars-data-panel__section-title')).toHaveCount(3);
    await page.locator('.lcars-data-panel__close').click();
    await expect(page.locator('.lcars-data-panel')).toHaveCount(0);
  });
});

test.describe('SESSIONS surface (spec §5.3 + D6a)', () => {
  test('GRID/TIMELINE view toggle swaps the rendered mode', async ({ page }) => {
    await loadDemo(page);
    await page.locator('[role="button"][aria-label*="mode SESSIONS"]').click();
    const toggleBtns = page.locator('.lcars-mid-bar__view-btn');
    await expect(toggleBtns).toHaveCount(2);
    // Click TIMELINE — render flips.
    await toggleBtns.filter({ hasText: /TIMELINE/i }).click();
    await expect(page.locator('.lcars-timeline-mode')).toHaveCount(1);
    await expect(page.locator('.lcars-command-mode')).toHaveCount(0);
    // Click GRID — render flips back.
    await toggleBtns.filter({ hasText: /^GRID$/i }).click();
    await expect(page.locator('.lcars-command-mode')).toHaveCount(1);
  });
});

test.describe('PROJECTS surface (spec §5.1)', () => {
  test('index renders rows + sentiment chips; deep-link round-trips', async ({ page }) => {
    await loadDemo(page);
    await page.locator('[role="button"][aria-label*="mode PROJECTS"]').click();
    await expect(page).toHaveURL(/#projects$/);
    await expect(page.locator('.lcars-projects-index__row').first()).toBeVisible();
    const rowCount = await page.locator('.lcars-projects-index__row').count();
    expect(rowCount).toBeGreaterThan(0);
    // Drill into first non-UNASSIGNED row → detail surface.
    await page
      .locator('.lcars-projects-index__row:not(.lcars-projects-index__row--unassigned)')
      .first()
      .click();
    await expect(page).toHaveURL(/#project\//);
    await expect(page.locator('.lcars-project-detail')).toBeVisible();
    await expect(page.locator('.lcars-project-detail__back')).toBeVisible();
  });
});

test.describe('TOPICS surface (spec §5.2)', () => {
  test('index renders rows; detail shows session grid + cross-project chips', async ({
    page,
  }) => {
    await loadDemo(page);
    await page.locator('[role="button"][aria-label*="mode TOPICS"]').click();
    await expect(page).toHaveURL(/#topics$/);
    const rowCount = await page.locator('.lcars-topics-index__row').count();
    if (rowCount === 0) {
      // Demo manifest may have no topics — ensure the empty state still renders.
      await expect(page.locator('text=NO TOPICS YET')).toBeVisible();
      return;
    }
    await page.locator('.lcars-topics-index__row').first().click();
    await expect(page).toHaveURL(/#topic\//);
    await expect(page.locator('.lcars-topic-detail')).toBeVisible();
  });
});

test.describe('PRACTICE surface (spec §5.4 / D13)', () => {
  test('renders the four lens sections', async ({ page }) => {
    await loadDemo(page);
    await page.locator('[role="button"][aria-label*="mode PRACTICE"]').click();
    await expect(page).toHaveURL(/#practice$/);
    await expect(page.locator('.lcars-practice__lens')).toHaveCount(4);
    const lensTitles = await page
      .locator('.lcars-practice__lens-title')
      .allTextContents();
    expect(lensTitles).toEqual([
      'YOUR PATTERNS',
      'AGENT PATTERNS',
      'PROCESS GAPS',
      'VALUE LEAKS',
    ]);
  });
});

test.describe('FilterBar disclosure (v2-visual-polish)', () => {
  // The `+N more` pill on the projects row was perceived as static
  // because of dashed borders + 0.7 opacity. The fix swapped those
  // for a solid, full-opacity treatment with a chevron in the label
  // and asserts the click handler still reveals the hidden tail —
  // i.e. when expanded, the row's project-pill count grows by
  // exactly the disclosed `rest.length`.
  test('clicking SHOW N MORE expands the projects row in-place', async ({ page }) => {
    await loadDemo(page);
    await page.locator('[role="button"][aria-label*="mode SESSIONS"]').click();
    const projectsRow = page.locator('.lcars-filter-bar__pills--project').first();
    await expect(projectsRow).toBeVisible();
    const restPill = projectsRow.locator('.lcars-project-pill--rest');
    if ((await restPill.count()) === 0) {
      // Demo manifest may have ≤ 8 projects so no rest tail is shown;
      // the affordance only renders when there's something to disclose.
      test.skip(true, 'Demo manifest has no rest tail — disclosure not exercised.');
      return;
    }
    await expect(restPill).toHaveAttribute('aria-expanded', 'false');
    const collapsedCount = await projectsRow
      .locator('.lcars-project-pill:not(.lcars-project-pill--rest):not(.lcars-project-pill--unknown)')
      .count();
    const labelText = (await restPill.textContent()) ?? '';
    const more = Number((labelText.match(/SHOW (\d+) MORE/) ?? [])[1] ?? '0');
    expect(more).toBeGreaterThan(0);
    await restPill.click();
    await expect(restPill).toHaveAttribute('aria-expanded', 'true');
    const expandedCount = await projectsRow
      .locator('.lcars-project-pill:not(.lcars-project-pill--rest):not(.lcars-project-pill--unknown)')
      .count();
    expect(expandedCount).toBe(collapsedCount + more);
  });
});

test.describe('TopBar single-row invariant (v2-visual-polish)', () => {
  // The TopBar must fit on a single row at desktop widths. Two prior
  // sources of wrap have been removed:
  //   - the `EXTENDED · COMING SOON` sibling chip in the tier slot
  //   - the `EARTHDATE` prefix label on the date chip
  // Asserts the chip count + that title and earthdate share a row.
  test('@desktop tier indicator is a single chip; earthdate has no label prefix', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'desktop',
      'Single-row guarantee is only meaningful at desktop widths.',
    );
    await loadDemo(page);
    await expect(page.locator('.lcars-tier-indicator')).toHaveCount(1);
    await expect(page.locator('.lcars-tier-indicator--pending')).toHaveCount(0);
    // Earthdate chip renders just the value — no inner label span.
    await expect(page.locator('.lcars-top-bar__earthdate-label')).toHaveCount(0);
    const titleTop = await page
      .locator('.lcars-top-bar__title')
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
    const earthdateTop = await page
      .locator('.lcars-top-bar__earthdate')
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
    expect(Math.abs(titleTop - earthdateTop)).toBeLessThanOrEqual(2);
  });
});

test.describe('Surface chrome gating (regression)', () => {
  // The shared SESSIONS chrome (UpperPanel KPI tiles + sparkline,
  // MidBar label, FilterBar source pills + project chips) reads from
  // the filtered-session list and is therefore noise on the v2
  // surfaces (PROJECTS, TOPICS, PRACTICE). Toggling its source pills
  // does nothing on those surfaces because they don't consume
  // `filteredSorted`. This regression suite asserts the chrome is
  // ABSENT on the v2 surfaces and PRESENT on SESSIONS.
  for (const surface of ['PROJECTS', 'TOPICS', 'PRACTICE'] as const) {
    test(`${surface} hides the SESSIONS chrome (UpperPanel + MidBar + FilterBar)`, async ({
      page,
    }) => {
      await loadDemo(page);
      await page.locator(`[role="button"][aria-label*="mode ${surface}"]`).click();
      await expect(page.locator('.lcars-upper-panel')).toHaveCount(0);
      await expect(page.locator('.lcars-mid-bar')).toHaveCount(0);
      await expect(page.locator('.lcars-filter-bar')).toHaveCount(0);
    });
  }

  test('SESSIONS keeps the chrome present', async ({ page }) => {
    await loadDemo(page);
    await page.locator('[role="button"][aria-label*="mode SESSIONS"]').click();
    await expect(page.locator('.lcars-upper-panel')).toHaveCount(1);
    await expect(page.locator('.lcars-mid-bar')).toHaveCount(1);
    await expect(page.locator('.lcars-filter-bar')).toHaveCount(1);
  });
});
