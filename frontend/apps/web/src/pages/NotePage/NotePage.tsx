import { useRef, useEffect, useState, useCallback } from 'react';

import { useQuery, useMutation } from '@apollo/client';
import {
  GlobalUID,
  LoadingPage,
  buildNoteRecord,
  captureNote,
  forgetQueuedNote,
  isQueuedNote,
  newNoteId,
  usePageTitle,
  useOutboxQueue,
} from '@ci/common';
import { Editor } from '@ci/editor';
import { Spinner } from '@ci/shadcn';
import { Check, CloudOff, TriangleAlert } from '@ci/shadcn/icons';
import { useParams, useNavigate } from 'react-router-dom';
import TimeAgo from 'react-timeago';

import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

const AUTOSAVE_THROTTLE_MS = 1000;

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

export function NotePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

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
   * Two jobs, and the second is a safety guard rather than a convenience:
   *
   * 1. It survives the editor remount. Navigating from `/notes/new` to the minted id
   *    changes `<Editor key>`, so the editor rebuilds from `content` — which is
   *    `note?.content`, and offline there is no `note`. Without this the text the user
   *    just typed would vanish from the screen the instant it was safely queued.
   * 2. It is the proof that a later snapshot is safe to queue. Queueing overwrites the
   *    whole note, so it may only ever be done with content we actually hold. Having
   *    authored it here is one of the two ways to hold it; the other is `note`, which
   *    means the appliance served it to us.
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

  usePageTitle(
    displayTitle ? `Note - ${displayTitle} - Companion Intelligence` : 'Note - Companion Intelligence',
  );

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
  if (loading && authoredContent === null) {
    return <LoadingPage />;
  }

  return (
    <>
      {/* `authoredContent` carries an offline note across the remount that navigating to
          its minted id forces (`key` changes), where there is no server `note` to rebuild
          from. See the state declaration. */}
      <Editor key={id} content={note?.content ?? authoredContent ?? undefined} onUpdate={handleUpdate}>
        <div className="flex h-full flex-col overflow-hidden">
          <Editor.Menu>
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
              {saveError ? (
                <>
                  <TriangleAlert className="text-destructive h-4 w-4" strokeWidth={1.5} />
                  <div>{saveError}</div>
                </>
              ) : updating || creating ? (
                <>
                  <Spinner size={12} variant="circle" color="rgb(6,108,128)" />
                  <div>Saving</div>
                </>
              ) : queuedAt ? (
                // Queued is a SAVED state, not a pending one: the note is committed to
                // the sidecar's on-disk queue and survives force-quit. It shows as saved
                // (with the reason it is not on the appliance yet) rather than as a
                // warning, because there is nothing for the user to do about it.
                <>
                  <CloudOff className="text-amber-400 h-4 w-4" strokeWidth={1.5} />
                  <div title="Saved on this device. It syncs to your Companion automatically.">
                    Saved offline
                  </div>
                </>
              ) : isDirty ? (
                <>
                  <TriangleAlert className="text-amber-300 h-4 w-4" strokeWidth={1.5} />
                  {note?.updatedAt ? (
                    <TimeAgo date={note.updatedAt} minPeriod={5} formatter={shortFormatter} />
                  ) : null}
                </>
              ) : id !== 'new' && note?.updatedAt ? (
                <>
                  <Check className="text-[rgb(6,108,128)] h-4 w-4 -mr-0.5" />
                  <TimeAgo date={note.updatedAt} minPeriod={5} formatter={shortFormatter} />
                </>
              ) : null}
            </div>
          </Editor.Menu>

          <div className="flex-1 min-h-0">
            <PageContent className="p-0">
              <Editor.Content />
            </PageContent>
          </div>
        </div>
      </Editor>
    </>
  );
}

function shortFormatter(value: string, unit: string) {
  switch (unit) {
    case 'second':
      return `${value}s ago`;
    case 'minute':
      return `${value}m ago`;
    case 'hour':
      return `${value}h ago`;
    case 'day':
      return `${value}d ago`;
    case 'week':
      return `${value}w ago`;
    case 'month':
      return `${value}mo ago`;
    case 'year':
      return `${value}y ago`;
    default:
      return '';
  }
}

function hasContent(content: string) {
  return content.replace(/<[^>]*>/g, '').trim().length > 0;
}

function extractTitle(content: string) {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const div = doc.body;

  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    if (node.textContent?.trim()) {
      let element = node.parentElement;
      while (element && element !== div) {
        if (
          ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DIV'].includes(
            element.tagName,
          )
        ) {
          return element.textContent?.trim().substring(0, 100) || 'Untitled note';
        }

        element = element.parentElement;
      }

      return node.textContent?.trim().substring(0, 100) || 'Untitled note';
    }

    node = walker.nextNode();
  }

  return 'Untitled note';
}
