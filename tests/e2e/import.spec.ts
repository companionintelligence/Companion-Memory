import { expect, test } from './fixtures/authenticated';
import path from 'node:path';

/**
 * The single most valuable e2e gap this session found: nothing drove an
 * import end-to-end. Imports were the most bug-prone surface of the whole
 * session (several real production bugs fixed today), and no spec proved the
 * three-step wizard — pick a source, upload an export, sync — actually lands
 * data in the Memory UI.
 *
 * Uses the smallest fixture available (tests/e2e/fixtures/contacts.vcf, a
 * copy of the backend's own vCard importer test fixture — two contacts,
 * ~400 bytes) so the run is fast and deterministic. "Apple Contacts" is the
 * picker tile: its importer (`vcard`) is `importerReady: true`, confirmed via
 * `GET /import/sources/catalog` against the running dev API, and — unlike
 * "Google Contacts" — it is not absorbed into a bundle tile (no Apple bundle
 * exists in wizard/sources.tsx), so it renders as its own clickable button
 * with the exact accessible name "Apple Contacts".
 */

const FIXTURE = path.resolve(__dirname, 'fixtures/contacts.vcf');

test('imports a vCard export end-to-end and the contacts land in Memory', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/sources/import');

  // Step 1: Pick. Wait for the catalog to load (tiles render once
  // `listCatalog()` resolves), then pick Apple Contacts and continue.
  const appleContacts = page.getByRole('button', { name: 'Apple Contacts' });
  await expect(appleContacts).toBeVisible({ timeout: 15_000 });
  await appleContacts.click();
  await expect(appleContacts).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: /Continue → 1 selected/ }).click();

  // Step 2: Export. The upload input is hidden (DropZone renders a real
  // <input type="file"> for click-to-browse, not just drag-and-drop) but
  // still targetable by its aria-label.
  // Role-scoped: the drop zone's own copy ("Drop your Apple Contacts export\n  // here") also contains this string, so a bare text match is ambiguous.
  await expect(page.getByRole('heading', { name: 'Apple Contacts' })).toBeVisible();
  await page.getByLabel('Choose export files to import').setInputFiles(FIXTURE);

  // The upload completes and its unpack+parse run starts immediately
  // (ExportStep.handleFiles). Wait for the run to finish parsing — the
  // finished-run row renders "<n> records" once the server reports a
  // terminal status (isRunFinished / FinishedRow in LiveRunList.tsx).
  //
  // "0 records" here, not "2 records": `records` is a deliberately narrow
  // metric — "rows this run actually wrote to ci.*" (ImportRunService's own
  // recordsFor() reads only the PUSH stage's detail.pushed, never the parse
  // stage's item count; see its doc comment). This run's stage list is
  // unpack+parse+media — no push — so 0 is the correct, honest value the
  // instant it reaches terminal status. The "Finish → Sync" button below
  // isn't itself gated on that terminal status (ExportStep.tsx has no
  // isRunFinished check on it), so this wait is still load-bearing: without
  // it, a click here can race a run that hasn't finished parsing yet.
  await expect(page.getByText(/0 records/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /Finish → Sync/ }).click();

  // Step 3: Sync. The staged run should show up as unpushed with 2 pending
  // contact items (one per vCard in the fixture).
  await expect(page.getByText(/ready to save/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Sync to my memory' }).click();

  // The push run also finishes — and, like the parse run above, correctly
  // reports "0 records" pushed. The push stage's persisted detail reads
  // {"pushed": 0, "deduped": 2, "entities": {"resolved": 2, ...}, "summary":
  // {"dropsByReason": {"represented_elsewhere": 2}, "gaps": []}}.
  // `records`/`detail.pushed` counts item-level rows landed in ci.*
  // (communications, events, content); a vCard contact resolves straight to a
  // Person entity with no accompanying item, so it is correctly excluded —
  // same rule as the ImportRunService.recordsFor() doc comment: entity
  // resolutions are deliberately "not records at all". The parser stages each
  // card twice, as that Person and as an item `destinationsFor` routes
  // nowhere ON PURPOSE (`isRepresentedElsewhere`), so the two items are an
  // expected drop, not a gap. (Before that rule they were counted under
  // `no_destination` and listed in `gaps` — a loss report about contacts
  // that had arrived.)
  // The real proof this import worked is below: both contacts findable by
  // name in Memory.
  await expect(page.getByText(/0 records/).last()).toBeVisible({ timeout: 60_000 });

  // Confirm the data actually landed: both contacts are findable in the
  // Memory People view, by name — proof the import did not just report
  // success but actually persisted to ci.* and is queryable.
  await page.goto('/memory/people');

  // Driven from the HEADER box, not a per-page input: /memory/people is an
  // `isLiveSearchPath` page, so GlobalSearchBox edits its `?search=` in place
  // and the page renders no input of its own.
  const search = page.getByPlaceholder('Search memory…');

  await search.fill('John Doe');
  await expect(page.getByText('John Doe', { exact: true })).toBeVisible({ timeout: 15_000 });

  await search.fill('Jane Smith');
  await expect(page.getByText('Jane Smith', { exact: true })).toBeVisible({ timeout: 15_000 });
});
