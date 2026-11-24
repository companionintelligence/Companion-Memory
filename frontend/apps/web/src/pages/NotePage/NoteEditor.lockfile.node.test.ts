import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * The note editor breaks when the bundle holds two copies of a ProseMirror core
 * package: Enter, lists and quotes throw "looks like multiple versions of
 * prosemirror-model were loaded" (NoteEditor.commands.test.tsx drives that).
 * Yarn leaves existing ranges on the old copy when @tiptap/pm moves ahead, so a
 * dependency bump splits them again without a word. If this fails, run
 * `yarn dedupe 'prosemirror-*'`.
 */
const lockfile = readFileSync(new URL('../../../../../../yarn.lock', import.meta.url), 'utf8');

describe('yarn.lock', () => {
  it.each(['prosemirror-model', 'prosemirror-state', 'prosemirror-transform', 'prosemirror-view'])(
    'resolves one copy of %s',
    (name) => {
      const versions = [...lockfile.matchAll(new RegExp(`^  resolution: "${name}@npm:(.+)"$`, 'gm'))].map(
        (match) => match[1],
      );

      expect(versions).toHaveLength(1);
    },
  );
});
