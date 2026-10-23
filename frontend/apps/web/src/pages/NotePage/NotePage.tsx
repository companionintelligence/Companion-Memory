import { useRef, useEffect, useState, useCallback } from 'react';

import { useQuery, useMutation } from '@apollo/client';
import {
  buildNoteRecord,
  captureNote,
  forgetQueuedNote,
  GlobalUID,
  isQueuedNote,
  LoadingPage,
  newNoteId,
  useDeviceLayout,
  useOutboxQueue,
  usePageTitle,
} from '@ci/common';
import { Editor } from '@ci/editor';
import { Spinner } from '@ci/shadcn';
import { Check, CloudOff, TriangleAlert } from '@ci/shadcn/icons';
import { useParams, useNavigate } from 'react-router-dom';
import TimeAgo from 'react-timeago';

import { useReplicaDatabase } from '@/api/powersync/deviceFallback';
import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';
import { namedChatContext } from '@/lib/agentChat';

import { LocalNotePage } from './LocalNotePage';
import {
  claimMintedNote,
  createNoteEditorSession,
  editorContentSeed,
  syncNoteEditorSession,
  type NoteEditorSession,
} from './noteEditorSession';
import { extractTitle, hasContent, shortFormatter } from './noteText';
import { useEntityReference } from './useEntityReference';

const AUTOSAVE_THROTTLE_MS = 1000;

/**
 * The save status's words ("Saving", "Saved offline", "5m"). A phone's toolbar has
 * no room left beside the formatting buttons, so there only the icon shows and the
 * words stay in the accessible name; wider screens show both, as before.
 */
const STATUS_WORDS = 'sr-only device:not-sr-only';

const GET_NOTE = gql(`
  query GetNote($id: ID!) {
    note(id: $id) {
      id
      title
      content
      updatedAt
    }
  }
`);

const UPDATE_NOTE = gql(`
  mutation UpdateNote($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      success
      note {
        id
        title
        content
        updatedAt
      }
    }
  }
`);

const CREATE_NOTE = gql(`
  mutation CreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      success
      note {
        id
        title
        content
        updatedAt
      }
    }
  }
`);

/**
 * A note. On a phone with a synced replica it is the phone's local copy,
 * read and written in the `notes` table and synced both ways by PowerSync
 * ({@link LocalNotePage}); everywhere else it is the appliance's, through
 * GraphQL, with the capture outbox as the offline fallback ({@link RemoteNotePage}).
 */
export function NotePage() {
  return useReplicaDatabase() ? <LocalNotePage /> : <RemoteNotePage />;
}

export function RemoteNotePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { reference, onReferenceClick } = useEntityReference();
  const { isMobile } = useDeviceLayout();

  const { data, loading, refetch } = useQuery(GET_NOTE, {
    variables: { id: GlobalUID.encode('note', id!) },
    skip: !id || id === 'new',
  });

  // Queue depth, watched only to notice the moment a queued note has drained.
  const { pending } = useOutboxQueue();

  const [updateNote, { loading: updating }] = useMutation(UPDATE_NOTE);

  const [createNote, { loading: creating }] = useMutation(CREATE_NOTE, {
    update(cache, { data }) {
      if (data?.createNote && data.createNote.success) {
        cache.writeQuery({
          query: GET_NOTE,
          variables: {
            id: data.createNote.note!.id,
          },
          data: {
            note: data.createNote.note,
          },
        });

        cache.modify({
          fields: {
            notes(existingNotes = { edges: [] }) {
              const newNoteRef = cache.writeFragment({
                data: data.createNote.note,
                fragment: gql(`
                  fragment NewNote on NoteType {
                    id
                    title
                    content
                    updatedAt
                  }
                `),
              });

              return {
                ...existingNotes,
                edges: [{ node: newNoteRef }, ...existingNotes.edges],
              };
            },
          },
        });
      }
    },
  });

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<string | null>(null);
  const isCreatingRef = useRef(false);

  const [isDirty, setIsDirty] = useState(false);

  /**
   * The note as THIS page authored it, held only while the appliance is out of reach.
   *
   * It is the proof that a later snapshot is safe to queue. Queueing overwrites the
   * whole note, so it may only ever be done with content we actually hold. Having
   * authored it here is one of the two ways to hold it; the other is `note`, which
   * means the appliance served it to us.
   *
   * The editor itself is not remounted when this draft's id is minted (see
   * `editorSessionRef`), so the text the user just typed stays on screen without
   * being copied back in through `content`.
   */
  const [authoredContent, setAuthoredContent] = useState<string | null>(null);
  const [localTitle, setLocalTitle] = useState<string | null>(null);
  const [queuedAt, setQueuedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Mirrored into a ref for the unmount flush below, whose cleanup closure is built from
  // the render that registered it and would otherwise read a stale value.
  const authoredContentRef = useRef<string | null>(null);
  authoredContentRef.current = authoredContent;

  const note = data?.note;

  // One editor for a draft and the id it mints. A new route id would otherwise
  // remount the editor and focus it at the start, which is the same moment the
  // chat control appears.
  const editorSessionRef = useRef<NoteEditorSession | null>(null);
  const editorSession = (editorSessionRef.current ??= createNoteEditorSession(id));
  const editorKey = syncNoteEditorSession(id, editorSession);

  // Set once the editor for this key has been shown, so a note query that starts
  // at the mint handoff cannot swap the page for a loader and destroy the editor.
  const editorShownForKeyRef = useRef<string | null>(null);
  const contentSeedRef = useRef<{ key: string; content?: string } | null>(null);

  /**
   * Queue one complete snapshot of the note under `noteId`.
   *
   * The id is always the raw uuid from the route (or the freshly minted one), never
   * `note.id` — that is the base64 global id the GraphQL layer speaks, and `/v1/notes`
   * keys on the real uuid.
   */
  const queueSnapshot = useCallback(async (noteId: string, title: string, content: string) => {
    const outcome = await captureNote(buildNoteRecord({ id: noteId, title, content }));

    if (outcome.status === 'queued') {
      setAuthoredContent(content);
      setLocalTitle(title);
      setQueuedAt(outcome.record.captured_at);
      setSaveError(null);
      setIsDirty(false);

      return true;
    }

    // Nothing was stored anywhere. Say so — the one thing this path must never do is
    // let the editor keep looking saved.
    setSaveError(
      outcome.status === 'unavailable'
        ? 'Not saved — your Companion is unreachable and this device has no offline queue.'
        : `Not saved — ${outcome.message}`,
    );

    return false;
  }, []);

  useEffect(() => {
    // The appliance served this note back, so the drain landed and its id is no longer
    // owed. Later edits belong on the ordinary online path.
    if (id && id !== 'new' && note?.id) {
      forgetQueuedNote(id);
      setQueuedAt(null);
    }
  }, [id, note?.id]);

  // Only true once the queue has actually been seen holding something, so the effect
  // below cannot fire on the empty queue that exists before the first enqueue lands.
  const sawPendingRef = useRef(false);

  if (pending > 0) {
    sawPendingRef.current = true;
  }

  useEffect(() => {
    // The drain emptied the queue, so a note that was waiting is on the appliance now.
    // Ask for it again: nothing else would notice, and the page would go on claiming a
    // note is unsynced long after it synced.
    if (queuedAt && pending === 0 && sawPendingRef.current) {
      sawPendingRef.current = false;

      void refetch();
    }
  }, [pending, queuedAt, refetch]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current && contentRef.current !== null) {
        clearTimeout(saveTimeoutRef.current);

        const content = contentRef.current;
        const title = extractTitle(content);

        if (note?.id) {
          updateNote({
            variables: {
              input: {
                id: note.id,
                title,
                content,
              },
            },
          });

          return;
        }

        // A note this page authored offline owes the queue its last edit too. Fired
        // without awaiting, exactly like the mutation above — an unmount cannot wait —
        // but the target here is a loopback write to the sidecar, not the network.
        if (id && id !== 'new' && authoredContentRef.current !== null) {
          void captureNote(buildNoteRecord({ id, title, content }));
        }
      }
    };
  }, [id, note?.id, updateNote, createNote]);

  const displayTitle = note?.title ?? localTitle;

  usePageTitle(displayTitle ? `Note - ${displayTitle} - Companion Memory` : 'Note - Companion Memory');

  const handleUpdate = (content: string) => {
    contentRef.current = content;
    setIsDirty(true);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    if (id === 'new' && !hasContent(content)) {
      return;
    }

    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = null;

      const title = extractTitle(content);

      if (id === 'new') {
        if (isCreatingRef.current) {
          return;
        }

        isCreatingRef.current = true;

        try {
          const result = await createNote({
            variables: {
              input: {
                content,
                title,
              },
            },
          });

          if (result.data?.createNote?.note?.id) {
            const newId = GlobalUID.parse('note', result.data.createNote.note.id);

            if (editorSessionRef.current) {
              claimMintedNote(editorSessionRef.current, newId);
            }

            navigate(`/notes/${newId}`, { replace: true });
          }

          setIsDirty(false);
          setSaveError(null);
        } catch (e) {
          console.error('Failed to create note', e);

          // The appliance is out of reach. Mint the id HERE, before queueing: it is the
          // note's real and permanent id, not a placeholder standing in for one the
          // server will assign later, so the navigate below goes to the note's final URL
          // and nothing has to be swapped when the drain succeeds.
          const localId = newNoteId();

          if (await queueSnapshot(localId, title, content)) {
            if (editorSessionRef.current) {
              claimMintedNote(editorSessionRef.current, localId);
            }

            navigate(`/notes/${localId}`, { replace: true });
          }
        } finally {
          isCreatingRef.current = false;
        }

        return;
      }

      if (!id) {
        return;
      }

      if (note?.id) {
        try {
          await updateNote({
            variables: {
              input: {
                id: note.id,
                content,
                title,
              },
            },
          });

          setIsDirty(false);
          setSaveError(null);
        } catch (e) {
          console.error('Failed to save note', e);

          // Safe to queue: the appliance served this note, so the editor is holding its
          // true content and a snapshot cannot overwrite anything with less than it had.
          await queueSnapshot(id, title, content);
        }

        return;
      }

      if (authoredContent !== null) {
        // A note this page created while offline. Still ours, still complete.
        await queueSnapshot(id, title, content);

        return;
      }

      // The note did not load and this page never authored it, so whatever the editor is
      // showing is not the note. Queueing that would replace the real content with an
      // empty document — and `captured_at` would not save us, because the empty snapshot
      // genuinely is the newer one. Refuse, and say why.
      setSaveError(
        isQueuedNote(id)
          ? 'Queued — this note is waiting to sync and cannot be edited until it does.'
          : 'Not saved — this note could not be loaded, so changes cannot be queued.',
      );
    }, AUTOSAVE_THROTTLE_MS);
  };

  // Not while we are holding the note ourselves: navigating to a freshly minted id
  // starts a query that will fail (that is why the note was queued), and blanking the
  // page for it would take the user's just-typed text off the screen and back.
  // Also not when this editor is already on screen — the mint handoff starts the
  // note query (and mounts the chat control) while the user is still typing.
  if (loading && authoredContent === null && editorShownForKeyRef.current !== editorKey) {
    return <LoadingPage />;
  }

  editorShownForKeyRef.current = editorKey;

  const contentSeed = (contentSeedRef.current = editorContentSeed(
    contentSeedRef.current,
    editorKey,
    note?.content ?? authoredContent,
  ));

  return (
    <>
      <Editor key={editorKey} content={contentSeed.content} onUpdate={handleUpdate} reference={reference}>
        <div className="flex h-full flex-col overflow-hidden">
          <Editor.Menu>
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
                {saveError ? (
                  <>
                    <TriangleAlert className="text-destructive h-4 w-4" strokeWidth={1.5} />
                    <div>{saveError}</div>
                  </>
                ) : updating || creating ? (
                  <>
                    <Spinner size={12} variant="circle" color="rgb(6,108,128)" />
                    <div className={STATUS_WORDS}>Saving</div>
                  </>
                ) : queuedAt ? (
                  // Queued is a SAVED state, not a pending one: the note is committed to
                  // the sidecar's on-disk queue and survives force-quit. It shows as saved
                  // (with the reason it is not on the appliance yet) rather than as a
                  // warning, because there is nothing for the user to do about it.
                  <>
                    <CloudOff className="text-amber-400 h-4 w-4" strokeWidth={1.5} />
                    <div
                      className={STATUS_WORDS}
                      title="Saved on this device. It syncs to your Companion automatically."
                    >
                      Saved offline
                    </div>
                  </>
                ) : isDirty ? (
                  <>
                    <TriangleAlert className="text-amber-300 h-4 w-4" strokeWidth={1.5} />
                    {note?.updatedAt ? (
                      <span className={STATUS_WORDS}>
                        <TimeAgo date={note.updatedAt} minPeriod={5} formatter={shortFormatter} />
                      </span>
                    ) : null}
                  </>
                ) : id !== 'new' && note?.updatedAt ? (
                  <>
                    <Check className="text-[rgb(6,108,128)] h-4 w-4 -mr-0.5" />
                    <span className={STATUS_WORDS}>
                      <TimeAgo date={note.updatedAt} minPeriod={5} formatter={shortFormatter} />
                    </span>
                  </>
                ) : null}
              </div>
              {note ? (
                <ChatWithAgentMenu
                  context={namedChatContext({
                    title: note.title,
                    body: note.content
                      ? note.content
                          .replace(/<[^>]+>/g, ' ')
                          .replace(/\s+/g, ' ')
                          .trim()
                      : null,
                    sourceKind: 'NoteType',
                    sourceId: note.id,
                  })}
                  // A phone gets the one-icon menu (same actions, "Open chat" first):
                  // the two labelled buttons need ~290px the toolbar row does not have.
                  size={isMobile ? 'icon' : 'sm'}
                />
              ) : null}
            </div>
          </Editor.Menu>

          <div className="flex-1 min-h-0">
            <PageContent className="p-0">
              <Editor.Content onReferenceClick={onReferenceClick} />
            </PageContent>
          </div>
        </div>
      </Editor>
    </>
  );
}
