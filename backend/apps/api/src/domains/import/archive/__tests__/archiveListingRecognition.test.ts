import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';

import '../../datasources';
import {
  listingHasRecords,
  recognizeArchiveListing,
  recognizeListingRoots,
} from '../archiveListingRecognition';
import { listRemoteZipEntries, type ReadRange } from '../remoteZipListing';

/** A ReadRange over an in-memory "remote" file that records what was asked for. */
function rangeReader(bytes: Buffer): { read: ReadRange; requested: number[] } {
  const requested: number[] = [];

  return {
    requested,
    read: async (offset, length) => {
      requested.push(length);

      return bytes.subarray(offset, offset + length);
    },
  };
}

function zipOf(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, body] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(body));
  }

  return zip.toBuffer();
}

describe('listRemoteZipEntries', () => {
  it('lists entry paths from the tail of the archive', async () => {
    const bytes = zipOf({ 'a/one.json': '{}', 'a/b/two.txt': 'two', 'three.jpg': 'x' });
    const { read } = rangeReader(bytes);

    expect((await listRemoteZipEntries(bytes.length, read))?.sort()).toEqual([
      'a/b/two.txt',
      'a/one.json',
      'three.jpg',
    ]);
  });

  it('reads only the tail and the directory, never the payload', async () => {
    // 4 MiB of incompressible payload ahead of a tiny directory.
    const payload = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 2654435761) >>> 24;
    }

    const zip = new AdmZip();
    zip.addFile('your_facebook_activity/big.bin', payload);
    const bytes = zip.toBuffer();
    const { read, requested } = rangeReader(bytes);

    expect(await listRemoteZipEntries(bytes.length, read)).toEqual(['your_facebook_activity/big.bin']);
    expect(requested.reduce((a, b) => a + b, 0)).toBeLessThan(128 * 1024);
  });

  it('answers null for bytes that are not a zip', async () => {
    const bytes = Buffer.from('%PDF-1.7 this is not an archive at all, just some text padding');

    expect(await listRemoteZipEntries(bytes.length, rangeReader(bytes).read)).toBeNull();
  });

  it('lets a failed read propagate instead of calling it "not a zip"', async () => {
    await expect(
      listRemoteZipEntries(1000, async () => {
        throw new Error('network down');
      }),
    ).rejects.toThrow('network down');
  });
});

describe('recognizeArchiveListing', () => {
  it('recognises a Facebook export from its file names alone', async () => {
    expect(
      await recognizeArchiveListing([
        'your_facebook_activity/posts/your_posts_1.json',
        'your_facebook_activity/messages/inbox/alice_1/message_1.json',
        'ads_information/ad_preferences.json',
      ]),
    ).toEqual(['facebook']);
  });

  it('recognises an export nested under a wrapper folder', async () => {
    expect(
      await recognizeArchiveListing([
        'Takeout/Google Photos/Photos from 2020/a.jpg',
        'Takeout/Google Photos/Photos from 2020/a.jpg.supplemental-metadata.json',
      ]),
    ).toContain('google_photos');
  });

  it('does not treat a project backup as an export because of single files inside it', async () => {
    // Each of these is claimed by SOME importer on its extension alone, and a
    // top-level messages/ folder is Facebook's weakest (0.6) signal.
    expect(
      await recognizeArchiveListing([
        'proj/src/index.ts',
        'proj/package.json',
        'proj/calendar.ics',
        'proj/track.gpx',
        'proj/contacts.vcf',
        'proj/mail.mbox',
        'proj/messages/readme.md',
        'proj/photo.jpg',
      ]),
    ).toEqual([]);
  });

  it('never writes outside its own temp tree', async () => {
    const outside = path.join(os.tmpdir(), `ci-listing-escape-${process.pid}.txt`);

    await recognizeArchiveListing([`../${path.basename(outside)}`, '/etc/ci-listing-escape', 'ok/file.txt']);

    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.existsSync('/etc/ci-listing-escape')).toBe(false);
  });

  it('leaves no temp tree behind', async () => {
    // Watch the tree this call makes, not the temp dir's whole listing: other
    // test workers lay out trees of their own there at the same time.
    const mkdtemp = jest.spyOn(fs.promises, 'mkdtemp');

    try {
      await recognizeArchiveListing(['your_facebook_activity/posts/your_posts_1.json']);

      const made = await mkdtemp.mock.results[0].value;

      expect(made).toContain('ci-archive-listing-');
      expect(fs.existsSync(made)).toBe(false);
    } finally {
      mkdtemp.mockRestore();
    }
  });
});

describe('recognizeListingRoots', () => {
  const META = 'Apps/Meta/meta-2026-oct-05/facebook-user-2026-10-05-abc';

  it('finds an export folder deep inside a drive listing, and nothing else', async () => {
    const roots = await recognizeListingRoots(
      [
        `/${META}/your_facebook_activity/messages/inbox/friends_1/message_1.json`,
        `/${META}/your_facebook_activity/posts/media/a.jpg`,
        '/Camera Uploads/2012-07-15 14.50.40.jpg',
        '/Keys/ssh/me.pub',
        '/Getting Started.pdf',
      ],
      { maxDepth: 10 },
    );

    expect(roots).toEqual([{ root: META, importers: ['facebook'] }]);
  });

  it('does not look that deep unless asked', async () => {
    // Nine folders down: one past the default depth.
    const deep = `a/b/c/d/e/${META}`;

    expect(await recognizeListingRoots([`${deep}/your_facebook_activity/posts/your_posts_1.json`])).toEqual(
      [],
    );
  });

  it('reports the listing itself as the root when the export is at the top', async () => {
    expect(await recognizeListingRoots(['your_facebook_activity/posts/your_posts_1.json'])).toEqual([
      { root: '', importers: ['facebook'] },
    ]);
  });

  it('folds matches nested inside an export into its outermost folder', async () => {
    const roots = await recognizeListingRoots([
      'Takeout/Google Photos/Photos from 2020/a.jpg',
      'Takeout/Google Photos/Photos from 2020/a.jpg.supplemental-metadata.json',
      'Takeout/YouTube and YouTube Music/history/watch-history.html',
    ]);

    // However many importers claim pieces of it, no root sits inside another.
    for (const a of roots) {
      for (const b of roots) {
        expect(a !== b && b.root.startsWith(`${a.root}/`)).toBe(false);
      }
    }

    expect(roots.flatMap((r) => r.importers)).toContain('google_photos');
  });
});

describe('listingHasRecords', () => {
  const media = [
    'your_facebook_activity/messages/inbox/friends_1/photos/a.jpg',
    'your_facebook_activity/messages/inbox/friends_1/videos/b.mp4',
    'your_facebook_activity/messages/inbox/friends_1/files/c.pdf',
  ];

  it('says a Facebook export that is attachments and nothing else has nothing to read', () => {
    expect(listingHasRecords(['facebook'], media)).toBe(false);
  });

  it('says it has once a conversation or a post has arrived', () => {
    expect(
      listingHasRecords(
        ['facebook'],
        [...media, 'your_facebook_activity/messages/inbox/friends_1/message_1.json'],
      ),
    ).toBe(true);
    expect(listingHasRecords(['facebook'], [...media, 'your_facebook_activity/posts/your_posts.html'])).toBe(
      true,
    );
  });

  it('does not hold a folder back on behalf of an importer that cannot judge from names', () => {
    // Claimed by Facebook and by one with no opinion: the doubt goes to importing.
    expect(listingHasRecords(['facebook', 'google_takeout'], media)).toBe(true);
    expect(listingHasRecords(['no_such_importer'], media)).toBe(true);
    expect(listingHasRecords([], media)).toBe(true);
  });
});
