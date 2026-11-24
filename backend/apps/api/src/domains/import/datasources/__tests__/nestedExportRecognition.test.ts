import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '..';
import { dataSourcesRecognize, DEFAULT_RECOGNIZE_MAX_DEPTH } from '../registry';

/**
 * An export nested inside another export. A Google Takeout carries the whole
 * of Drive, so a Facebook export Meta transferred to Drive rides along inside
 * it, several folders down. The recognition a local import run performs
 * (`descend: true`, default depth) has to reach it, or the Facebook data is
 * imported as loose files by the catch-all importer.
 */
describe('recognising an export nested inside a Takeout', () => {
  let root: string;

  const FACEBOOK = [
    'your_facebook_activity/messages/inbox/friends_1/message_1.json',
    'your_facebook_activity/posts/your_posts_1.json',
  ];

  const layOut = (files: string[]): void => {
    for (const file of files) {
      const target = path.join(root, file);

      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
    }
  };

  const recognise = async (): Promise<Map<string, string>> => {
    const matches = await dataSourcesRecognize(
      undefined,
      { filename: path.basename(root), fullPath: root, fsRoot: root },
      {},
      { descend: true },
    );

    return new Map(matches.map((m) => [m.data_source.name, path.relative(root, m.matchedPath ?? root)]));
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nested-export-'));
    // The rest of the Takeout, as unpacked (its `Takeout/` wrapper flattened).
    layOut(['Drive/Taxes/2024.pdf', 'Google Photos/Photos from 2020/a.jpg']);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a Facebook export five folders down, where Meta writes it', async () => {
    const exportDir = 'Drive/Apps/Meta/meta-2026-oct-05/facebook-user-2026-10-05-abc';
    layOut(FACEBOOK.map((file) => `${exportDir}/${file}`));

    const matches = await recognise();

    expect(matches.get('facebook')).toBe(exportDir);
    // The Takeout's own parts are still recognised beside it.
    expect(matches.get('google_photos')).toBe('Google Photos');
  });

  it('finds an export that sorts after hundreds of sibling folders', async () => {
    // There used to be a 200-entries-per-folder cap; a crowded Drive root hid
    // whatever came after it.
    layOut(Array.from({ length: 450 }, (_, i) => `Drive/Folder ${String(i).padStart(3, '0')}/note.txt`));
    layOut(FACEBOOK.map((file) => `Drive/zz-facebook-export/${file}`));

    expect((await recognise()).get('facebook')).toBe('Drive/zz-facebook-export');
    // Every recogniser looks at each of the 450 folders: 5.5 to 11 s on a
    // 16-core workstation, so Jest's default 5 s fails it everywhere.
  }, 60_000);

  it('stops at the default depth', async () => {
    const tooDeep = Array.from({ length: DEFAULT_RECOGNIZE_MAX_DEPTH }, (_, i) => `d${i}`).join('/');
    layOut(FACEBOOK.map((file) => `${tooDeep}/facebook-export/${file}`));

    expect((await recognise()).has('facebook')).toBe(false);
  });
});
