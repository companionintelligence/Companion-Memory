import { dropGenericMailWhenSpecialised, dropGenericWhenSpecialised } from '../ParseStage';

/**
 * `generic` returns `confidence: 1` without inspecting anything, so it matches
 * every archive — and ParseStage runs EVERY recognized source. On a real Google
 * Takeout that re-read what the specialised parsers had already read: 80,067
 * duplicate staged rows beside 309,689 Google Voice ones, 67,065 filenames
 * overlapping exactly. They pushed as contentless `ci.content` rows, and since
 * `ci.content` has no time column they sorted ahead of every genuine memory —
 * so the default Memory view became 80k empty stubs.
 *
 * Upstream did this selection in its drop zone; the layer was never ported.
 */

function match(name: string) {
  return { data_source: { name } } as never;
}

function names(matches: unknown[]): string[] {
  return (matches as Array<{ data_source: { name: string } }>).map((m) => m.data_source.name);
}

describe('ParseStage generic exclusion', () => {
  it('drops generic when a real parser also claimed the tree', () => {
    const selected = dropGenericWhenSpecialised([
      match('google_voice'),
      match('generic'),
      match('google_photos'),
    ]);

    expect(names(selected)).toEqual(['google_voice', 'google_photos']);
  });

  it('keeps generic when it is the only match', () => {
    // The bare-.gpx / loose-PDF drag: generic is the whole point there.
    const selected = dropGenericWhenSpecialised([match('generic')]);

    expect(names(selected)).toEqual(['generic']);
  });

  it('leaves a purely specialised match set alone', () => {
    const selected = dropGenericWhenSpecialised([match('gmail'), match('calendar')]);

    expect(names(selected)).toEqual(['gmail', 'calendar']);
  });

  it('passes an empty match set through untouched', () => {
    expect(dropGenericWhenSpecialised([])).toEqual([]);
  });
});

/**
 * Path-scoped exclusion: the second fix, on top of the name-only gate above.
 * `dataSourcesRecognize` always attaches a real `matchedPath` to every match it
 * returns (`recognizeLevel` sets it unconditionally from `entry.fullPath`) —
 * these fixtures use that, unlike every one above, so they actually exercise
 * the containment logic instead of falling through to its "no path info"
 * fallback.
 *
 * The user-facing case this exists for: dragging a Facebook export (which
 * `facebook.ts` recognizes at 0.6 confidence off nothing more than a
 * `messages/` entry) alongside a loose file it never reads. The old name-only
 * gate silently dropped that loose file with the rest of `generic` — this
 * suite is what proves it now survives instead.
 */
function matchWithPath(name: string, matchedPath: string) {
  return { data_source: { name }, matchedPath } as never;
}

function namesAndExcludes(matches: unknown[]): Array<{ name: string; excludePaths?: string[] }> {
  return (matches as Array<{ data_source: { name: string }; excludePaths?: string[] }>).map((m) => ({
    name: m.data_source.name,
    excludePaths: m.excludePaths,
  }));
}

describe('ParseStage generic exclusion — path-scoped', () => {
  it('keeps generic, scoped to skip a single specialised subtree', () => {
    // generic collapses to the scratch root; facebook matched one level down —
    // exactly the shape `dataSourcesRecognize`'s own dedup produces.
    const selected = dropGenericWhenSpecialised([
      matchWithPath('facebook', '/scratch/run/facebook_export'),
      matchWithPath('generic', '/scratch/run'),
    ]);

    expect(namesAndExcludes(selected)).toEqual([
      { name: 'facebook', excludePaths: undefined },
      { name: 'generic', excludePaths: ['/scratch/run/facebook_export'] },
    ]);
  });

  it('accumulates an exclude path per specialised subtree, not just the first', () => {
    // The original-regression shape: several specialised claims scattered
    // through one Takeout tree, none of them the whole thing.
    const selected = dropGenericWhenSpecialised([
      matchWithPath('google_voice', '/scratch/run/Takeout/Voice'),
      matchWithPath('google_photos', '/scratch/run/Takeout/Google Photos'),
      matchWithPath('generic', '/scratch/run'),
    ]);

    const generic = namesAndExcludes(selected).find((m) => m.name === 'generic');

    expect(generic?.excludePaths).toEqual(
      expect.arrayContaining(['/scratch/run/Takeout/Voice', '/scratch/run/Takeout/Google Photos']),
    );
    expect(generic?.excludePaths).toHaveLength(2);
  });

  it('drops generic entirely when a specialised match spans its whole tree', () => {
    // A specialised recognizer matching AT the same root generic collapsed to
    // (rather than descending into it) claims everything generic would see —
    // scoping around it would exclude the entire tree for no benefit, so this
    // keeps today's simpler all-or-nothing drop.
    const selected = dropGenericWhenSpecialised([
      matchWithPath('gmail', '/scratch/run'),
      matchWithPath('generic', '/scratch/run'),
    ]);

    expect(namesAndExcludes(selected)).toEqual([{ name: 'gmail', excludePaths: undefined }]);
  });

  it("leaves a specialised match outside generic's tree without an exclusion", () => {
    // Defensive case: a specialised claim that is neither an ancestor of, nor
    // covered by, generic's own matchedPath (disjoint paths). Nothing overlaps,
    // so there is nothing to exclude, and the safe fallback applies.
    const selected = dropGenericWhenSpecialised([
      matchWithPath('spotify', '/scratch/other-run/spotify_export'),
      matchWithPath('generic', '/scratch/run'),
    ]);

    expect(namesAndExcludes(selected)).toEqual([{ name: 'spotify', excludePaths: undefined }]);
  });
});

/**
 * The mail form of the same rule. `email` (any .mbox / .eml) and `gmail`
 * (Takeout) both claim a Takeout mbox, and the stage runs every match — so one
 * file was parsed twice, once without the bulk gate. See
 * `dropGenericMailWhenSpecialised`.
 */
describe('ParseStage generic-mail exclusion', () => {
  const ROOT = '/scratch/run';
  const TAKEOUT_MBOX = `${ROOT}/google-takeout/Mail/All mail Including Spam and Trash.mbox`;

  function at(name: string, matchedPath?: string) {
    return { data_source: { name }, recognition: { confidence: 1 }, matchedPath } as never;
  }

  it('drops email when gmail claimed the same file', () => {
    const selected = dropGenericMailWhenSpecialised([at('gmail', TAKEOUT_MBOX), at('email', TAKEOUT_MBOX)]);

    expect(names(selected)).toEqual(['gmail']);
  });

  it('drops an email claim that sits ABOVE a gmail file (its walker would re-read the file)', () => {
    const selected = dropGenericMailWhenSpecialised([
      at('gmail', TAKEOUT_MBOX),
      at('email', `${ROOT}/google-takeout/Mail`),
    ]);

    expect(names(selected)).toEqual(['gmail']);
  });

  it('keeps an email claim on a sibling mailbox nothing specialised covers', () => {
    // A Yahoo mbox exported from Thunderbird, dropped beside the Takeout.
    const selected = dropGenericMailWhenSpecialised([
      at('gmail', TAKEOUT_MBOX),
      at('email', TAKEOUT_MBOX),
      at('email', `${ROOT}/yahoo_mail/Inbox`),
    ]);

    expect(selected.map((m: { matchedPath?: string }) => `${names([m])[0]}:${m.matchedPath}`)).toEqual([
      `gmail:${TAKEOUT_MBOX}`,
      `email:${ROOT}/yahoo_mail/Inbox`,
    ]);
  });

  it('keeps email when no specialised mail reader matched at all', () => {
    const selected = dropGenericMailWhenSpecialised([
      at('email', `${ROOT}/yahoo_mail/Inbox`),
      at('calendar', ROOT),
    ]);

    expect(names(selected)).toEqual(['email', 'calendar']);
  });

  it('falls back to dropping email when path info is missing (unknown means nested)', () => {
    const selected = dropGenericMailWhenSpecialised([at('gmail'), at('email')]);

    expect(names(selected)).toEqual(['gmail']);
  });

  it('leaves every non-mail match alone', () => {
    const selected = dropGenericMailWhenSpecialised([
      at('gmail', TAKEOUT_MBOX),
      at('google_voice', ROOT),
      at('generic', ROOT),
    ]);

    expect(names(selected)).toEqual(['gmail', 'google_voice', 'generic']);
  });
});
