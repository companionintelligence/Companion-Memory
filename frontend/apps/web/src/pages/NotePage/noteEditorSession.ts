/**
 * The note editor's React key.
 *
 * A new note is typed on `/notes/new` and then handed to `/notes/:id` once it
 * is saved. Keying the editor on the route id remounts it at that handoff, and
 * a fresh editor focuses at the start of the document — which is also when the
 * chat control appears, because that is the first moment a `note` exists. The
 * caret would jump to the beginning under the user's hands.
 *
 * One session covers the blank draft and the id it mints. A different note, or
 * another visit to `/notes/new`, starts a new session so that editor loads its
 * own document.
 */
export interface NoteEditorSession {
  key: string;
  /** Note id the route is showing for this session, or null while still on `/notes/new`. */
  routeId: string | null;
  /** Id this page minted for the draft, before or after the route catches up. */
  mintedId: string | null;
}

export function createNoteEditorSession(routeId: string | undefined): NoteEditorSession {
  const noteId = persistedNoteId(routeId);

  return {
    key: noteId ?? draftKey(),
    routeId: noteId,
    mintedId: null,
  };
}

/** Route the session onto `routeId`, keeping the key when this draft just minted it. */
export function syncNoteEditorSession(routeId: string | undefined, session: NoteEditorSession): string {
  const noteId = persistedNoteId(routeId);

  if (noteId === null) {
    // `/notes/new`. A session already bound to a saved note is a different draft.
    if (session.routeId !== null) {
      session.key = draftKey();
      session.routeId = null;
      session.mintedId = null;
    }

    return session.key;
  }

  if (noteId === session.routeId || noteId === session.mintedId) {
    session.routeId = noteId;

    return session.key;
  }

  session.key = noteId;
  session.routeId = noteId;
  session.mintedId = null;

  return session.key;
}

/** Call before navigating a draft to the id it just minted, so the editor key stays put. */
export function claimMintedNote(session: NoteEditorSession, noteId: string) {
  session.mintedId = noteId;
}

/**
 * Document the editor was opened with. Later saves echo new HTML through the
 * note query; feeding that back in would push a new `content` option into the
 * live editor while the user is typing.
 */
export function editorContentSeed(
  seed: { key: string; content?: string } | null,
  editorKey: string,
  content: string | null | undefined,
): { key: string; content?: string } {
  if (seed?.key === editorKey) {
    return seed;
  }

  return { key: editorKey, content: content ?? undefined };
}

function persistedNoteId(routeId: string | undefined): string | null {
  if (!routeId || routeId === 'new') {
    return null;
  }

  return routeId;
}

function draftKey() {
  return `draft-${Math.random().toString(36).slice(2, 10)}`;
}
