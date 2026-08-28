# Test Fixtures

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

This directory contains test data fixtures for the data source importers in
`backend/apps/api/src/domains/import/datasources/`. (These importers were ported
from the now-retired CI-Import-Tools repo — renamed `ZARCHIVED-CI-Import-Tools` —
so paths in older copies of this file pointed at `src/datasources/`. The paths
below are this repo's.)

## Purpose

The fixtures provide standardized test data for:
- **Recognition testing**: Verify that each importer correctly recognizes its expected data format
- **Import testing**: Validate that each importer can successfully parse and import data
- **Regression testing**: Ensure consistent behavior across code changes

## Structure

Each fixture represents a minimal valid export from a specific data source. There
are 67 fixture directories and a handful of loose files today; `ls` this
directory for the current set rather than trusting a list here. The naming
convention is `<source>-export/`, with a suffix when one source has several eras
or formats worth covering separately (`netflix-export/` vs
`netflix-simple-export/`, `discord-export/` vs `discord-export-json/`,
`spotify-export/` vs `spotify-extended/`, `instagram-html-export/` vs
`instagram-html-activity/`).

Not every importer has a persistent fixture: of the 88 test files in the parent
directory, 51 read from here and 66 build a tree with `mkdtemp` at run time.
Prefer a persistent fixture when the *bytes* are the thing under test (an
encoding, a line ending, a real vendor layout) and `mkdtemp` when the test only
needs some file to exist.

### Text-based Formats

- **`sample.ics`**: Calendar events in iCalendar format
- **`apple-calendar-valarm.ics`**: A real-shaped Apple Calendar export — folded
  lines, a `VTIMEZONE`, and a `BEGIN:VALARM` sub-component *inside* every
  `VEVENT` carrying its own `UID`/`DESCRIPTION`/`SUMMARY`/`ATTENDEE`. The bytes
  are the thing under test: the parser used to fold those nested properties into
  the event and lose the event's real description and identity. Also holds a
  recurring master plus two `RECURRENCE-ID` overrides that share its `UID`.
- **`sample.vcf`**: vCard contacts with multiple contact entries
- **`sample.geojson`**: GeoJSON location data with points and line strings

### SQLite Databases

- **`AddressBook-v22.abcddb`**: Apple Contacts database with sample contact
- **`places.sqlite`**: Firefox browsing history database

### Directory-based Exports

- **`google-location-legacy/`**: Google Location History legacy format
  - Contains `Records.json` with location data in E7 coordinate format
  
- **`google-voice-export/`**: Google Voice HTML conversation export
  - `Phones.vcf`: Owner phone information
  - `Bills.html`: Billing history placeholder
  - `Calls/conversation-1.html`: Sample conversation HTML

- **`twitter-archive/`**: Twitter data archive format
  - `data/manifest.js`: Archive metadata
  - `data/tweets.js`: Sample tweets data

### `.gitattributes` — `* -text`, and why

Several importers are tested precisely on how they handle line endings — the
`google-voice-export-crlf-vcf/` corpus exists to prove the vCard parser copes
with CRLF. Git's default eol normalization would rewrite those bytes on checkout
and silently turn that test into a duplicate of the LF one, so normalization is
disabled for this whole directory. Do not "clean up" a fixture's line endings.

## Creating Database Fixtures

The SQLite database fixtures were created using the `create_test_dbs.ts` script,
which sits in this directory and writes beside itself. To regenerate them, run it
through the workspace's own ts-node (this repo is yarn PnP, so `npx tsx` will not
resolve `better-sqlite3`):

```bash
# from the repo root
yarn workspace @ci/be-api run exec src/domains/import/datasources/__tests__/fixtures/create_test_dbs.ts
```

**It is not idempotent.** The `CREATE TABLE` statements are `IF NOT EXISTS` but
the `INSERT`s are not, so running it over the committed files fails with
`SQLITE_CONSTRAINT_PRIMARYKEY`. Delete `AddressBook-v22.abcddb` and
`places.sqlite` first.

## Using Fixtures in Tests

Tests resolve the directory from the test file's own location:

```typescript
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const samplePath = path.join(FIXTURES_DIR, 'sample.ics');
```

(`__dirname`, not `import.meta.dirname` — these suites run under jest/CommonJS.)

## Best Practices

1. **Minimal Data**: Fixtures should contain the minimum data needed to test the importer
2. **Representative**: Data should represent typical structure from real exports
3. **Stable**: Fixtures should not change unnecessarily to avoid breaking tests
4. **Documented**: Complex formats should have comments explaining the structure

## Coverage

The registry holds **71** importers (`datasources/index.ts` — one
`registerDataSource` call per file), and the parent directory holds 88 test
files. An earlier revision of this section listed 19 sources under the heading
"all 21 data sources"; both numbers were wrong, and a hand-maintained checklist
of source names goes stale on the next importer. Get the current answer from the
code instead:

```bash
# every registered importer
grep -c "^import './" ../../index.ts

# which importers have a test file at all
ls ../*.test.ts

# which of those read from this directory rather than building a tmpdir
grep -l FIXTURES_DIR ../*.test.ts
```

Note that three registered ids differ from their filename, and the id is what
`staged_items.data_source` records: `applecontacts.ts` → `apple_contacts`,
`contactlist.ts` → `contact_list`, `googlevoice.ts` → `google_voice`.

Some data sources use temporary directory creation in tests rather than
persistent fixtures because they require minimal setup or dynamic test data.

There is a second README in this directory,
[`microsoft-privacy-export-README.md`](./microsoft-privacy-export-README.md),
which records how each column of the two Microsoft fixture sets was verified —
worth copying for any vendor whose export format is undocumented.
