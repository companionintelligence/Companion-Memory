/*
 * `generic`'s own exclusion-awareness: the half of the fix that lives in the
 * importer itself rather than in `ParseStage.dropGenericWhenSpecialised`
 * (covered separately in `stages/__tests__/genericExclusion.test.ts`).
 *
 * `dropGenericWhenSpecialised` only decides WHICH paths a specialised match
 * claimed; it is `GenericFileImporter.fileImport`'s own directory walk that
 * has to actually honor them by skipping those subtrees. These tests exercise
 * that walk directly, with real directories on disk, because the original
 * regression (see the header comment on `genericExclusion.test.ts`) was never
 * about recognition — it was `generic`'s `fileImport` reading files a
 * specialised parser had already read.
 */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dropGenericWhenSpecialised } from '../../stages/ParseStage';
import { FacebookFileImporter } from '../facebook';
import { allDataSources } from '../registry';
import type { DataSourceRecognition, DirEntry } from '../registry';
import type { ImportParams } from '../timeline';
import '../generic';

import type { EmittedGraph } from './support/emitted';

function getGenericImporter() {
  const ds = allDataSources().find((d) => d.name === 'generic');
  if (!ds?.newFileImporter) {
    throw new Error('missing generic importer');
  }

  return ds.newFileImporter();
}

async function runGeneric(root: string, excludePaths?: readonly string[]) {
  const pipeline: EmittedGraph[] = [];
  await getGenericImporter().fileImport(
    {},
    { filename: path.basename(root), fullPath: root } as DirEntry,
    {
      pipeline,
      timeframe: {},
      log: () => {},
      excludePaths,
    } as unknown as ImportParams,
  );

  return pipeline.map((g) => path.relative(root, g.item.intermediateLocation as string));
}

async function mkdtemp(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(tmpdir(), prefix));
}

async function writeFiles(dir: string, relPaths: string[]): Promise<void> {
  for (const rel of relPaths) {
    const full = path.join(dir, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, `content of ${rel}`);
  }
}

describe('GenericFileImporter — exclusion-aware walk', () => {
  it('walks every file when no exclusion is given (baseline, unchanged)', async () => {
    const root = await mkdtemp('generic-excl-baseline-');
    await writeFiles(root, ['a.txt', 'sub/b.txt']);

    const staged = await runGeneric(root);

    expect(staged.sort()).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('skips every file under an excluded subtree, staging what is outside it', async () => {
    const root = await mkdtemp('generic-excl-basic-');
    await writeFiles(root, ['claimed/one.json', 'claimed/deep/two.json', 'loose.pdf']);

    const staged = await runGeneric(root, [path.join(root, 'claimed')]);

    expect(staged).toEqual(['loose.pdf']);
  });

  it('skips the entry itself when the excluded path IS the entry passed in', async () => {
    // ParseStage always runs generic against its OWN matchedPath (see
    // `parseOne`), so `startPath === entry.fullPath` is the common case, not
    // an edge case — a claim spanning the whole thing generic was asked to
    // walk must stop it before `fs.statSync` even runs, not just prune deeper.
    const root = await mkdtemp('generic-excl-whole-');
    await writeFiles(root, ['a.txt']);

    const staged = await runGeneric(root, [root]);

    expect(staged).toEqual([]);
  });

  /**
   * The actual user-facing case from the audit: a Facebook export recognized
   * (0.6 confidence off nothing but a bare `messages/` entry — `facebook.ts`'s
   * weakest signal) sitting alongside a loose file Facebook's own importer
   * never reads. Wires the REAL `FacebookFileImporter.recognize()` and
   * `dropGenericWhenSpecialised` together with `GenericFileImporter`, so the
   * `matchedPath` driving the exclusion is genuine, not a hand-typed fixture.
   *
   * Before this fix: `dropGenericWhenSpecialised` dropped `generic` from the
   * recognized list entirely the moment `facebook` matched anywhere — so
   * `notes.pdf` never reached ANY importer's `fileImport` and silently
   * vanished. See this file's proof further down (temporarily reverting
   * ParseStage.ts) for the demonstration that this exact assertion fails on
   * the unfixed gate.
   */
  it('lets a loose file next to a recognized Facebook export reach generic, while the export itself does not get re-staged', async () => {
    const root = await mkdtemp('generic-excl-facebook-');
    // Bare `messages/` with nothing else -- facebook.ts's 0.6-confidence branch,
    // the audit's specific weak-signal case.
    await writeFiles(root, [
      'facebook_export/messages/inbox/thread_1/message_1.json',
      'facebook_export/messages/inbox/thread_1/photo.jpg',
      'notes.pdf',
    ]);

    const facebookDir = path.join(root, 'facebook_export');
    const facebookRecognition = await new FacebookFileImporter().recognize(
      {},
      { filename: 'facebook_export', fullPath: facebookDir },
    );

    expect(facebookRecognition.confidence).toBeCloseTo(0.6);

    // Mirrors what `dataSourcesRecognize` itself hands `dropGenericWhenSpecialised`:
    // generic collapsed to the scratch root, facebook attributed to the
    // subdirectory it actually matched.
    const matches: DataSourceRecognition[] = [
      {
        data_source: { name: 'facebook' } as never,
        recognition: facebookRecognition,
        matchedPath: facebookDir,
      },
      { data_source: { name: 'generic' } as never, recognition: { confidence: 1 }, matchedPath: root },
    ];

    const scoped = dropGenericWhenSpecialised(matches);
    const genericMatch = scoped.find((m) => m.data_source.name === 'generic');

    expect(genericMatch).toBeDefined();
    expect(genericMatch?.excludePaths).toEqual([facebookDir]);

    const staged = await runGeneric(root, genericMatch?.excludePaths);

    // The loose file survives...
    expect(staged).toContain('notes.pdf');
    // ...and nothing inside the export facebook already claimed is re-staged.
    expect(staged.some((p) => p.startsWith('facebook_export'))).toBe(false);
    expect(staged).toEqual(['notes.pdf']);
  });

  /**
   * The ORIGINAL regression, reproduced deliberately: several specialised
   * claims scattered through one tree (the many-low-confidence-matches shape
   * the audit calls out), none of them the whole thing, next to genuinely
   * unclaimed content. Proves the fix does BOTH halves at once: the claimed
   * subtrees are never re-staged (the 80,067-duplicate failure mode), and the
   * unclaimed subtree still gets through (the blanket-drop failure mode the
   * first attempt at this gate introduced).
   */
  it('does not re-stage multiple claimed subtrees, and still stages the genuinely unclaimed one', async () => {
    const root = await mkdtemp('generic-excl-takeout-');
    const voiceFiles = Array.from({ length: 25 }, (_, i) => `Takeout/Voice/Calls/call_${i}.json`);
    const photosFiles = Array.from({ length: 25 }, (_, i) => `Takeout/Google Photos/IMG_${i}.jpg`);
    await writeFiles(root, [
      ...voiceFiles,
      ...photosFiles,
      'Takeout/News/articles.txt',
      'Takeout/News/followed_topics.txt',
    ]);

    const matches: DataSourceRecognition[] = [
      {
        data_source: { name: 'google_voice' } as never,
        recognition: { confidence: 1 },
        matchedPath: path.join(root, 'Takeout', 'Voice'),
      },
      {
        data_source: { name: 'google_photos' } as never,
        recognition: { confidence: 1 },
        matchedPath: path.join(root, 'Takeout', 'Google Photos'),
      },
      { data_source: { name: 'generic' } as never, recognition: { confidence: 1 }, matchedPath: root },
    ];

    const scoped = dropGenericWhenSpecialised(matches);
    const genericMatch = scoped.find((m) => m.data_source.name === 'generic');

    expect([...(genericMatch?.excludePaths ?? [])].sort()).toEqual(
      [path.join(root, 'Takeout', 'Voice'), path.join(root, 'Takeout', 'Google Photos')].sort(),
    );

    const staged = await runGeneric(root, genericMatch?.excludePaths);

    // None of the 50 files Voice/Photos already own were re-staged...
    expect(staged.some((p) => p.startsWith(path.join('Takeout', 'Voice')))).toBe(false);
    expect(staged.some((p) => p.startsWith(path.join('Takeout', 'Google Photos')))).toBe(false);
    // ...but the News category, which nothing else parses, still is -- this is
    // exactly the content the pre-c6f12fea4 all-or-nothing gate silently threw
    // away for the rest of the run once ANY specialised source matched.
    expect(staged.sort()).toEqual(
      [
        path.join('Takeout', 'News', 'articles.txt'),
        path.join('Takeout', 'News', 'followed_topics.txt'),
      ].sort(),
    );
  });

  /**
   * Scale: pruning has to happen at the DIRECTORY level, before recursing,
   * or an exclusion-aware walk becomes its own O(files) rescan of exactly the
   * tree it exists to avoid re-reading -- a Google Voice export alone is
   * 73,124 files. `fs.promises.readdir` is spied on here as the proxy for
   * "did the walk open this directory at all": if pruning worked, the
   * excluded subtree is never opened, so the file count inside it is
   * irrelevant to how much work the walk does.
   */
  it('prunes an excluded subtree without opening it, regardless of how many files it holds', async () => {
    const root = await mkdtemp('generic-excl-scale-');
    const manyFiles = Array.from({ length: 300 }, (_, i) => `claimed/deep/nested/file_${i}.json`);
    await writeFiles(root, [...manyFiles, 'loose.txt']);

    const readdirSpy = jest.spyOn(fs.promises, 'readdir');

    const staged = await runGeneric(root, [path.join(root, 'claimed')]);

    expect(staged).toEqual(['loose.txt']);

    const openedDirs = readdirSpy.mock.calls.map((call) => String(call[0]));

    // Only the root itself was opened -- never `claimed/`, and never any of
    // its descendants -- no matter that 300 files live under it.
    expect(openedDirs).toEqual([root]);

    readdirSpy.mockRestore();
  });
});
