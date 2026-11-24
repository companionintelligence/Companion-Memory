import { describe, expect, it } from 'vitest';

import {
  claimMintedNote,
  createNoteEditorSession,
  editorContentSeed,
  syncNoteEditorSession,
} from './noteEditorSession';

describe('note editor session', () => {
  it('keeps one key from a blank draft through the id it mints', () => {
    const session = createNoteEditorSession('new');
    const draftKey = syncNoteEditorSession('new', session);

    claimMintedNote(session, 'minted-note-id');

    // The claim lands before navigation, so a render can still be on `/notes/new`.
    expect(syncNoteEditorSession('new', session)).toBe(draftKey);
    expect(syncNoteEditorSession('minted-note-id', session)).toBe(draftKey);
    expect(syncNoteEditorSession('minted-note-id', session)).toBe(draftKey);
  });

  it('starts a new editor when the route moves to a different note', () => {
    const session = createNoteEditorSession('note-a');
    const first = syncNoteEditorSession('note-a', session);

    expect(syncNoteEditorSession('note-b', session)).not.toBe(first);
    expect(syncNoteEditorSession('note-b', session)).toBe('note-b');
  });

  it('starts a new draft after leaving a saved note for /notes/new', () => {
    const session = createNoteEditorSession('new');
    const draftKey = syncNoteEditorSession('new', session);

    claimMintedNote(session, 'minted-note-id');
    syncNoteEditorSession('minted-note-id', session);

    const nextDraft = syncNoteEditorSession('new', session);

    expect(nextDraft).not.toBe(draftKey);
    expect(syncNoteEditorSession('new', session)).toBe(nextDraft);
  });

  it('keeps an existing note on its own key', () => {
    const session = createNoteEditorSession('abc-uuid');

    expect(syncNoteEditorSession('abc-uuid', session)).toBe('abc-uuid');
    expect(syncNoteEditorSession('abc-uuid', session)).toBe('abc-uuid');
  });

  it('does not replace the seeded document when the same editor receives newer HTML', () => {
    const session = createNoteEditorSession('new');
    const editorKey = syncNoteEditorSession('new', session);

    const seeded = editorContentSeed(null, editorKey, undefined);
    const echoed = editorContentSeed(seeded, editorKey, '<p>saved copy</p>');

    expect(echoed).toBe(seeded);
    expect(echoed.content).toBeUndefined();
  });

  it('seeds a different note from its own content', () => {
    const session = createNoteEditorSession('note-a');
    const firstKey = syncNoteEditorSession('note-a', session);
    const first = editorContentSeed(null, firstKey, '<p>A</p>');

    const secondKey = syncNoteEditorSession('note-b', session);
    const second = editorContentSeed(first, secondKey, '<p>B</p>');

    expect(second.content).toBe('<p>B</p>');
  });
});
