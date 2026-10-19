import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import '../../datasources';
import { allDataSources, dataSourcesRecognize } from '../../datasources/registry';
import { LISTING_CONFIDENCE_FLOOR, recognizeArchiveListing } from '../archiveListingRecognition';

/**
 * Which exports a cloud-drive sync can recognise WITHOUT downloading them.
 *
 * A Google Drive or Dropbox sync decides whether a zip or a folder is a data
 * export from its file listing alone (see archiveListingRecognition.ts): the
 * recognisers run over a tree of empty files. An importer that knows its
 * export by the shape of its folders (Facebook's `your_facebook_activity/`,
 * a Takeout's category folders) says yes; one that has to open a file — a
 * CSV header, a JSON field — sees nothing and says no, and that export stays
 * in the drive unimported though the wizard would import the same file if a
 * person uploaded it.
 *
 * This test measures that gap over every export fixture the importers' own
 * tests ship, and pins the answer, so it is read off this file rather than
 * re-derived, and so a change to it is a deliberate one:
 *
 *  - an importer moving from CONTENTS_ONLY to FROM_NAMES means someone taught
 *    its recogniser to answer from paths — the fix for a drive-held export;
 *  - the reverse means a recogniser started needing bytes, and exports of that
 *    kind in people's drives silently stopped being picked up.
 *
 * Read the CONTENTS_ONLY list with its fixtures in mind: most are one or two
 * files, flatter than the real export, and the listing rule counts only a
 * match on a DIRECTORY. An importer there may answer from names on a real
 * export whose folder shape the fixture does not reproduce — Netflix's
 * `CONTENT_INTERACTION/ViewingActivity.csv`, say. The list is "not shown to
 * work from names", not "proven to need contents".
 */
const FIXTURES = path.resolve(__dirname, '../../datasources/__tests__/fixtures');

/** Importers at least one fixture export is recognised as from its file names alone. */
const FROM_NAMES = [
  'amazon',
  'apple_music',
  'apple_photos',
  'facebook',
  'fitbit',
  'google_fit',
  'google_location',
  'google_maps_places',
  'google_my_activity',
  'google_purchases',
  'google_voice',
  'instagram',
  'kindle',
  'microsoft_account',
  'snapchat',
  'spotify',
  'twitter',
  'whatsapp',
  'withings',
  'youtube',
];

/**
 * Importers whose fixture exports are recognised only once the files have
 * contents. From a drive these are downloaded only as loose documents (by the
 * catch-all importer) or not at all.
 */
const CONTENTS_ONLY = [
  'apple_health',
  'chatgpt',
  'claude',
  'discord',
  'disney_plus',
  'evernote',
  'garmin',
  'gemini',
  'github',
  'google_keep',
  'grok',
  'hulu',
  'linkedin',
  'lyft',
  'mastodon',
  'myfitnesspal',
  'netflix',
  'oura',
  'reddit',
  'remember_the_milk',
  'sms_backup_restore',
  'strava',
  'telegram',
  'tiktok',
  // vcard is matched inside the Google Voice fixtures by the .vcf it holds — a
  // single-file match, which the listing rule ignores on purpose.
  'vcard',
  'venmo',
];

/**
 * File importers no fixture directory exercises, so nothing here can say
 * which list they belong on. Several are single-file formats (.ics, .gpx,
 * .vcf, .mbox, a lone CSV) that the listing rule excludes by design; the rest
 * are simply unmeasured. Adding a fixture for one moves it to a list above.
 */
const UNMEASURED = [
  'amazon_music',
  'apple_contacts',
  'audible',
  'calendar',
  'chromium',
  'coinbase',
  'contact_list',
  'email',
  'firefox',
  'flickr',
  'flighty',
  'geojson',
  'gmail',
  'goodreads',
  'google_chrome',
  'google_photos',
  'gpx',
  'imessage',
  'kindle_reading',
  'kmlgx',
  'last_fm',
  'letterboxd',
  'macos_activity',
  'nmea',
  'notion',
  'paypal',
  'prime_video',
  'robinhood',
  'roblox',
  'uber',
];

/**
 * These two read a PDF report's cover with pdftotext. Without the binary they
 * fall back to a 0.5 claim on the file name, under LISTING_CONFIDENCE_FLOOR, so
 * no fixture measures them. The appliance image ships poppler-utils and the
 * lists above assume it; ci.yml's runner does not, so there they count as
 * unmeasured, as disney_plus.test.ts and hulu.test.ts skip their PDF cases.
 */
const NEEDS_PDFTOTEXT = ['disney_plus', 'hulu'];

function pdftotextAvailable(): boolean {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });

    return true;
  } catch {
    return false;
  }
}

const HAS_PDFTOTEXT = pdftotextAvailable();
const EXPECTED_CONTENTS_ONLY = HAS_PDFTOTEXT
  ? CONTENTS_ONLY
  : CONTENTS_ONLY.filter((name) => !NEEDS_PDFTOTEXT.includes(name));
const EXPECTED_UNMEASURED = HAS_PDFTOTEXT ? UNMEASURED : [...UNMEASURED, ...NEEDS_PDFTOTEXT];

/** The catch-all claims any tree, so its match says nothing; the listing rule drops it too. */
const GENERIC = 'generic';

function walk(dir: string, rel = ''): string[] {
  const paths: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      paths.push(...walk(path.join(dir, entry.name), relPath));
    } else {
      paths.push(relPath);
    }
  }

  return paths;
}

interface FixtureResult {
  fixture: string;
  /** What the import run recognises once the bytes are here, at the listing's own confidence floor. */
  withContents: string[];
  /** What the drive sync recognises from the listing alone. */
  fromNames: string[];
}

async function measure(): Promise<FixtureResult[]> {
  const results: FixtureResult[] = [];

  for (const fixture of fs.readdirSync(FIXTURES).sort()) {
    const dir = path.join(FIXTURES, fixture);

    if (!fs.statSync(dir).isDirectory()) {
      continue;
    }

    const matches = await dataSourcesRecognize(
      undefined,
      { filename: fixture, fullPath: dir, fsRoot: dir },
      {},
      { descend: true },
    );
    const withContents = [
      ...new Set(
        matches
          .filter(
            (match) =>
              match.data_source.name !== GENERIC && match.recognition.confidence >= LISTING_CONFIDENCE_FLOOR,
          )
          .map((match) => match.data_source.name),
      ),
    ];
    // The fixture folder stands in for the export's own top folder, as it
    // would sit in a drive.
    const fromNames = await recognizeArchiveListing(walk(dir).map((relPath) => `${fixture}/${relPath}`));

    results.push({ fixture, withContents, fromNames });
  }

  return results;
}

describe('what a drive sync recognises from file names alone', () => {
  let results: FixtureResult[] = [];

  beforeAll(async () => {
    results = await measure();
  }, 120_000);

  it('never claims an export from names that the import run would not recognise with the bytes', () => {
    const overclaims = results
      .filter((result) => result.fromNames.some((name) => !result.withContents.includes(name)))
      .map(
        (result) => `${result.fixture}: ${result.fromNames.join(',')} vs ${result.withContents.join(',')}`,
      );

    expect(overclaims).toEqual([]);
  });

  it('recognises these importers’ exports from names alone', () => {
    const fromNames = new Set(results.flatMap((result) => result.fromNames));

    expect([...fromNames].sort()).toEqual([...FROM_NAMES].sort());
  });

  it('recognises these only once the files have contents', () => {
    const fromNames = new Set(results.flatMap((result) => result.fromNames));
    const contentsOnly = new Set(
      results.flatMap((result) => result.withContents).filter((name) => !fromNames.has(name)),
    );

    expect([...contentsOnly].sort()).toEqual([...EXPECTED_CONTENTS_ONLY].sort());
  });

  it('has a fixture for every other file importer, or lists it as unmeasured', () => {
    const measured = new Set(results.flatMap((result) => result.withContents));
    const unmeasured = allDataSources()
      .filter(
        (source) => source.newFileImporter != null && source.name !== GENERIC && !measured.has(source.name),
      )
      .map((source) => source.name);

    expect(unmeasured.sort()).toEqual([...EXPECTED_UNMEASURED].sort());
  });
});
