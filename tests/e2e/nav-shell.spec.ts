import { expect, test, type Page } from './fixtures/authenticated';

/**
 * The application shell — Power Rail, Memory submenu, Self tile — end to end.
 *
 * The unit tests in `layouts/Main/**` already cover the rail's own logic against
 * a mocked feature set. What they cannot see is whether a rail row points at a
 * route that actually renders, whether the two nav surfaces that are supposed to
 * be generated from one source really do agree in a running app, and whether the
 * way out of the app still exists.
 *
 * ═══ WHY THE SELF TILE HAS ITS OWN TEST ═════════════════════════════════════
 *
 * `railDestinations.ts` carries an in-code post-mortem: the Self tile once rode
 * `stats.page`, and the tile is the only mount point for `NavUserMenu` — the
 * only Settings / Theme / Log out cluster in the shell. Turning off a flag named
 * for a *statistics page* therefore removed the user's avatar, the theme
 * switcher, Settings, and every way to sign out, leaving no route back except
 * clearing storage. This spec pins the property that regression violated:
 * **from a signed-in app you can always reach Log out, and it works.**
 */

// Top-level rows that ship enabled by default (`config/default.json`). Asks is
// deliberately absent: it rides *under* Saved Searches as a child row, which the
// group test below covers. Tasks and Calendar are likewise absent: Plan and
// Calendar were merged into one 'Planning' destination at /plan, with Tasks
// (/plan/tasks) and Calendar (/plan/calendar) as its submenu children — covered
// by the Planning group test below rather than as top-level rows here.
// Deliberately not derived from `railDestinations.ts` — a test that imports the
// same table as the code under test agrees with it by construction, including
// when both are wrong.
const DEFAULT_ROWS = [
  { label: 'Planning', path: '/plan' },
  { label: 'Memory', path: '/memory' },
  { label: 'Saved Searches', path: '/saved-searches' },
  { label: 'Sources', path: '/sources' },
  { label: 'Jobs', path: '/jobs' },
] as const;

/**
 * The rail ships collapsed to icons; submenus only mount once it is open.
 *
 * Opening it hands over to the drawer — a *second* nav landmark, labelled
 * "Main navigation drawer" and carrying `id="power-rail"`. Scoping to the
 * collapsed "Main navigation" after opening finds the group expanders in the
 * DOM but never actionable, which reads as a hang rather than a miss.
 */
async function openRail(page: Page) {
  const drawer = page.locator('#power-rail');

  // WAIT FOR THE SHELL TO MOUNT BEFORE CLICKING ANYTHING. This is the whole
  // reason this helper used to fail. Straight after `goto` the rail and the
  // toggle are not in the DOM at all: a probe against a real stack read
  // `railCount: 0, toggles: [], stored: null` at the instant the old first
  // line ran. Playwright's `click()` auto-waits for the button to APPEAR, so
  // it did click — but it landed in the window between React putting the
  // element in the DOM and attaching its handler, so `toggle()` never ran and
  // `ci-power-rail-expanded` was never written. The rail then sat at
  // `data-state="collapsed"` forever and the assertion below read as "the rail
  // does not open", which is not true: seeding that key and reloading in the
  // same probe gave `data-state="expanded"`, width 238, `aria-expanded="true"`.
  await expect(drawer).toBeVisible();

  const toggle = page.getByRole('button', { name: 'Open menu' });
  await expect(toggle).toBeVisible();

  // Click only while it is still collapsed, and retry the pair. A bare click
  // races the handler as described above; a bare retry would toggle the rail
  // shut again on the run where the first click DID land. This asserts the
  // effect rather than the click, so a genuinely broken toggle still fails
  // here rather than being papered over.
  await expect(async () => {
    if ((await drawer.getAttribute('data-state')) !== 'expanded') {
      await toggle.click();
    }

    expect(await drawer.getAttribute('data-state')).toBe('expanded');
  }).toPass({ timeout: 15_000 });

  // Park the pointer on the rail before doing anything slow — it is a drawer
  // that floats over the content, and the tests below walk its rows.
  await drawer.hover();

  // It slides in over 200ms; clicking mid-flight fails with "element is not
  // stable" rather than anything informative.
  await page.waitForTimeout(400);
  await expect(drawer).toHaveAttribute('data-state', 'expanded');

  return drawer;
}

/**
 * Open a rail group if it is closed. The toggle's accessible name flips between
 * "Expand X sections" and "Collapse X sections", and a group whose destination
 * is the current page starts already open — so a test that always clicks
 * "Expand …" hangs on exactly the page the group belongs to.
 */
async function ensureGroupOpen(rail: ReturnType<Page['locator']>, group: string, page: Page) {
  // Match either state so this *waits* for the toggle to exist. A bare
  // `count()` on the "Expand …" name is a snapshot with no auto-waiting: it
  // reads 0 while the drawer is still rendering and silently skips the click.
  const toggle = rail.getByRole('button', {
    name: new RegExp(`^(Expand|Collapse) ${group} sections$`),
  });

  await expect(toggle).toBeVisible();

  if (((await toggle.getAttribute('aria-label')) ?? '').startsWith('Expand')) {
    await toggle.click();
    await rail.hover();
    await page.waitForTimeout(400);
  }
}

test.describe('application shell', () => {
  test('every default rail destination reaches a page that renders', async ({ page }) => {
    await page.goto('/plan');

    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail).toBeVisible();

    // Assert the href rather than clicking through: the collapsed rail widens
    // on hover, so walking down it with the mouse shifts the rows still to
    // come and a click can land on the neighbour above. (That is a test
    // artefact, not a product bug — the click paths are covered by the Asks,
    // Memory and Self tests below, each of which parks the pointer first.)
    for (const row of DEFAULT_ROWS) {
      const link = rail.getByRole('link', { name: row.label, exact: true });

      await expect(link, `rail is missing a "${row.label}" row`).toBeVisible();
      await expect(link, `the "${row.label}" row points somewhere unexpected`).toHaveAttribute(
        'href',
        row.path,
      );
    }

    // Then prove each destination actually renders, rather than 404ing or
    // bouncing to /login — the failure mode a rail row gated on the wrong flag
    // produces.
    for (const row of DEFAULT_ROWS) {
      await page.goto(row.path);

      await expect(page).toHaveURL(new RegExp(row.path.replace('/', '\\/')));
      await expect(page.locator('main'), `${row.path} rendered no content well`).toBeVisible();
      await expect(page, `${row.path} bounced to /login`).not.toHaveURL(/\/login/);
    }
  });

  test('Asks rides under Saved Searches rather than as its own destination', async ({ page }) => {
    await page.goto('/plan');

    const rail = await openRail(page);

    // The group head is still its own destination — the child sits beside it,
    // it does not replace it.
    await expect(rail.getByRole('link', { name: 'Saved Searches', exact: true })).toBeVisible();
    await ensureGroupOpen(rail, 'Saved Searches', page);

    const asks = rail.getByRole('link', { name: 'Asks', exact: true });
    await expect(asks).toBeVisible();
    await asks.click();

    await expect(page).toHaveURL(/\/asks/);
    await expect(page.locator('main')).toBeVisible();
  });

  test('Planning rides as one destination with Tasks and Calendar as children', async ({ page }) => {
    await page.goto('/plan');

    const rail = await openRail(page);

    // The group head is still its own destination — the children sit beside
    // it, they do not replace it.
    await expect(rail.getByRole('link', { name: 'Planning', exact: true })).toBeVisible();
    await ensureGroupOpen(rail, 'Planning', page);

    const children = [
      { label: 'Tasks', path: '/plan/tasks' },
      { label: 'Calendar', path: '/plan/calendar' },
    ] as const;

    for (const child of children) {
      const link = rail.getByRole('link', { name: child.label, exact: true });

      await expect(link, `the Planning submenu is missing "${child.label}"`).toBeVisible();
      await expect(link, `the "${child.label}" row points somewhere unexpected`).toHaveAttribute(
        'href',
        child.path,
      );
    }

    // Then prove each sub-view actually renders, rather than 404ing or
    // bouncing to /login — the failure mode a rail row gated on the wrong
    // flag produces.
    for (const child of children) {
      await page.goto(child.path);

      await expect(page).toHaveURL(new RegExp(child.path.replace(/\//g, '\\/')));
      await expect(page.locator('main'), `${child.path} rendered no content well`).toBeVisible();
      await expect(page, `${child.path} bounced to /login`).not.toHaveURL(/\/login/);
    }
  });

  test('the Memory submenu and the in-page hub tabs agree', async ({ page }) => {
    await page.goto('/memory/events');

    // Both surfaces are generated from MEMORY_HUB_SECTIONS; if either is
    // hand-maintained they will drift, which is exactly what this catches.
    const hub = page.getByRole('navigation', { name: 'Memory sections' });
    await expect(hub).toBeVisible();

    const hubLabels = (await hub.getByRole('link').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(hubLabels.length, 'the Memory hub rendered no tabs').toBeGreaterThan(4);

    const rail = await openRail(page);
    await ensureGroupOpen(rail, 'Memory', page);

    for (const label of hubLabels) {
      await expect(
        rail.getByRole('link', { name: label, exact: true }),
        `the Memory rail submenu is missing "${label}", which the in-page hub tabs show`,
      ).toBeVisible();
    }
  });

  test('a hub tab survives a reload and the browser Back button', async ({ page }) => {
    await page.goto('/memory/events');
    await page.goto('/memory/people');
    await expect(page).toHaveURL(/\/memory\/people/);

    await page.reload();
    await expect(page).toHaveURL(/\/memory\/people/);
    await expect(page.locator('main')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/memory\/events/);
    await expect(page.locator('main')).toBeVisible();
  });

  test('the Self tile still carries Log out, and logging out works', async ({ page }) => {
    await page.goto('/plan');

    const rail = await openRail(page);

    // The tile is the account surface; Log out lives inside it, not in the
    // destination list.
    await ensureGroupOpen(rail, 'Self', page);

    const logout = rail.getByRole('button', { name: 'Log out' });
    await expect(logout, 'the shell has no Log out control').toBeVisible();

    await logout.click();

    // Signed out for real: the app lands on /login and a protected route no
    // longer opens.
    await expect(page).toHaveURL(/\/login/, { timeout: 20_000 });

    await page.goto('/memory/events');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a retired route redirects instead of 404ing', async ({ page }) => {
    // /search was retired when search moved into the header (App.tsx keeps the
    // redirect deliberately, for old bookmarks).
    //
    // It lands on `/memory`, NOT `/memory/events`. App.tsx draws that
    // distinction right below the redirect: "`/memory` is the unfiltered
    // explorer (all kinds). `/memory/events` is the same page with the Events
    // submenu's type filter." This asserted the filtered one, so it failed
    // against a redirect that has been working the whole time.
    //
    // The `(?|$)` tail is load-bearing: a bare /\/memory/ would also match
    // `/memory/events`, putting the wrong answer back within reach.
    await page.goto('/search');
    await expect(page).toHaveURL(/\/memory(\?|$)/);
  });
});
