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
  await expect(page.getByText(/2 records/)).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: /Finish → Sync/ }).click();

  // Step 3: Sync. The staged run should show up as unpushed with 2 pending
  // contact items (one per vCard in the fixture).
  await expect(page.getByText(/ready to save/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Sync to my memory' }).click();

  // The push run also finishes and reports records pushed.
  await expect(page.getByText(/2 records/).last()).toBeVisible({ timeout: 60_000 });

  // Confirm the data actually landed: both contacts are findable in the
  // Memory People view, by name — proof the import did not just report
  // success but actually persisted to ci.* and is queryable.
  await page.goto('/memory/people');
  await page.getByPlaceholder('Search people and communications...').fill('John Doe');
  await expect(page.getByText('John Doe', { exact: true })).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder('Search people and communications...').fill('Jane Smith');
  await expect(page.getByText('Jane Smith', { exact: true })).toBeVisible({ timeout: 15_000 });
});
