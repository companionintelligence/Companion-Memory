import { useRef, useEffect, useState, useCallback } from 'react';

import { useQuery, useMutation } from '@apollo/client';
import {
  buildNoteRecord,
  captureNote,
  CONNECTION_REPROBE_INTERVAL_MS,
  forgetQueuedNote,
  GlobalUID,
  isQueuedNote,
  LoadingPage,
  newNoteId,
  requestConnectionRefresh,
  useDeviceLayout,
  useOptionalConnectionMode,
  useOutboxQueue,
  usePageTitle,
} from '@ci/common';
import { Editor } from '@ci/editor';
import { AlertDialog, Spinner } from '@ci/shadcn';
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
import { useLeaveGuard } from './useLeaveGuard';

const AUTOSAVE_THROTTLE_MS = 1000;

/**
 * A save that failed and was stored nowhere (a browser has no offline queue) is sent again
 * on its own: first after this long, then twice as long each time, up to the connection
 * check's own interval. It also goes at once when the browser is back online, the tab
 * comes back to the front, or the connection check finds Memory again.
 */
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = CONNECTION_REPROBE_INTERVAL_MS;

/** How many recent contents a session remembers sending (see `SaveSession.known`). */
const KNOWN_CONTENTS = 10;

/**
 * Saving for the note on screen, one per editor session (`editorKey`): a new note and the
 * id it is saved under share one, and every other note gets its own.
 *
 * It lives in a ref, not in state. Timers, event listeners and saves that are still out
 * read it after the render that started them, and a save that is still out when the page
 * moves on has to go on writing to the note it belongs to.
 */
interface SaveSession {
  key: string;
  /** What the editor holds now. */
  content: string | null;
  /** The newest content stored somewhere: in Memory, or in this device's offline queue. */
  held: string | null;
  /** The note's global id once Memory has it, loaded or created by this page. */
  serverId: string | null;
  /**
   * The uuid a new note is created under. Minted before its first save and kept, so a
   * create sent again is the same note (`createNote` is idempotent by id), and a note
   * queued offline has the id a late create would have given it.
   */
  draftId: string | null;
  /** The route id, while this session is on screen (`new` for a new note). */
  routeId: string | undefined;
  /** This page authored the note offline (see `authoredContent`). */
  authored: boolean;
  /**
   * Memory's `updatedAt` for the version this page last saw. While a failed save waits to
   * go again, every save only writes over that version.
   */
  baseUpdatedAt: string | null;
  /** Saves sent and not answered yet. */
  inFlight: number;
  /** The wait before the next save is sent. */
  timer: ReturnType<typeof setTimeout> | null;
  /** A save failed, nothing stored it, and it is waiting to be sent again. */
  retrying: boolean;
  /** Memory has a version of the note this page never saw. Nothing more is saved from here. */
  changedElsewhere: boolean;
  /**
   * The note's contents this page loaded or sent most recently. A save the gateway gave up
   * on can still land later; when Memory then holds one of these, the change is this
   * page's own and not another device's.
   */
  known: string[];
}

function newSaveSession(key: string): SaveSession {
  return {
    key,
    content: null,
    held: null,
    serverId: null,
    draftId: null,
    routeId: undefined,
    authored: false,
    baseUpdatedAt: null,
    inFlight: 0,
    timer: null,
    retrying: false,
    changedElsewhere: false,
    known: [],
  };
}

function rememberContent(session: SaveSession, content: string | null) {
  if (content === null) {
    return;
  }

  session.known = [...session.known.filter((known) => known !== content), content].slice(-KNOWN_CONTENTS);
}

/**
 * The status of a 4xx answer to a failed save. Memory (not a gateway) turned the request
 * down: it is malformed for this Memory (an older one that does not know a field) or not
 * allowed, and sending it again gets the same answer. Anything else, no answer at all or
 * a gateway's 5xx, means Memory is out of reach, and the save goes again later.
 */
function refusedStatus(error: unknown): number | null {
  const status = (error as { networkError?: { statusCode?: unknown } } | null)?.networkError?.statusCode;

  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
    ? status
    : null;
}

/**
 * How long a save may stay unanswered before the toolbar stops saying "Saving".
 * Behind the Hub's gateway a request to a stopped Memory hangs for 30 s or more
 * before it fails. Until then the spinner was all the page showed.
 */
const SLOW_SAVE_MS = 8000;

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
   *
   * Kept under the editor session it was queued for (`key`), and read back only while
   * that session is on screen (`authoredContent` below). The route moves to another
   * note without remounting this page, and that note must not open with this text or
   * count as one this page authored.
   */
  const [offlineDraft, setOfflineDraft] = useState<{ key: string; content: string; title: string } | null>(
    null,
  );
  const [queuedSnapshot, setQueuedSnapshot] = useState<{ key: string; at: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Set while a failed save waits to be sent again; `attempt` sets how long the next wait is.
  const [retry, setRetry] = useState<{ attempt: number } | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);

  const note = data?.note;

  const saving = updating || creating;
  const [savingTooLong, setSavingTooLong] = useState(false);

  // Counts every save the appliance answered, landed or failed. Apollo keeps `loading`
  // true until the LATEST of overlapping saves settles, so without this an earlier save
  // landing would not restart the clock below, and a slow but working link would be
  // reported as not answering.
  const [answeredSaves, setAnsweredSaves] = useState(0);
  const countAnswer = () => setAnsweredSaves((count) => count + 1);

  useEffect(() => {
    setSavingTooLong(false);

    if (!saving) {
      return;
    }

    const timer = setTimeout(() => setSavingTooLong(true), SLOW_SAVE_MS);

    return () => clearTimeout(timer);
  }, [saving, answeredSaves]);

  // One editor for a draft and the id it mints. A new route id would otherwise
  // remount the editor and focus it at the start, which is the same moment the
  // chat control appears.
  const editorSessionRef = useRef<NoteEditorSession | null>(null);
  const editorSession = (editorSessionRef.current ??= createNoteEditorSession(id));
  const editorKey = syncNoteEditorSession(id, editorSession);

  const authoredContent = offlineDraft?.key === editorKey ? offlineDraft.content : null;
  const localTitle = offlineDraft?.key === editorKey ? offlineDraft.title : null;
  const queuedAt = queuedSnapshot?.key === editorKey ? queuedSnapshot.at : null;

  // Set once the editor for this key has been shown, so a note query that starts
  // at the mint handoff cannot swap the page for a loader and destroy the editor.
  const editorShownForKeyRef = useRef<string | null>(null);
  const contentSeedRef = useRef<{ key: string; content?: string } | null>(null);

  const saveSessionRef = useRef<SaveSession | null>(null);

  if (saveSessionRef.current?.key !== editorKey) {
    saveSessionRef.current = newSaveSession(editorKey);
  }

  const session = saveSessionRef.current;

  session.routeId = id;
  session.authored = authoredContent !== null;

  if (note?.id && session.serverId === null) {
    // The first time this page sees the note in Memory.
    session.serverId = note.id;
    session.baseUpdatedAt = note.updatedAt;
    session.held = note.content ?? null;
    rememberContent(session, session.held);
  }

  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Whether `s` is still the note on screen, so how its save ended may change what the page shows. */
  const isCurrent = (s: SaveSession) => mountedRef.current && saveSessionRef.current === s;

  /**
   * Queue one complete snapshot of the note under `noteId`.
   *
   * The id is always the raw uuid from the route (or the freshly minted one), never
   * `note.id` — that is the base64 global id the GraphQL layer speaks, and `/v1/notes`
   * keys on the real uuid.
   *
   * `capturedAtMs` is when the save that failed was SENT. A request can hang for 30 s
   * and fail after a newer save has already landed; stamping the snapshot with the
   * failure time would make it look newer than that save, and the drain would put the
   * older text back over it.
   *
   * `s` is the editor session the save belongs to. The page may have moved on to another
   * note while the save was out; the toolbar then shows that other note and is left alone.
   */
  const queueSnapshot = useCallback(
    async (s: SaveSession, noteId: string, title: string, content: string, capturedAtMs?: number) => {
      const outcome = await captureNote(buildNoteRecord({ id: noteId, title, content }, capturedAtMs));
      const onScreen = mountedRef.current && saveSessionRef.current === s;

      if (outcome.status === 'queued') {
        setOfflineDraft({ key: s.key, content, title });
        setQueuedSnapshot({ key: s.key, at: outcome.record.captured_at });

        if (onScreen) {
          setSaveError(null);
          setIsDirty(false);
        }

        return true;
      }

      // Nothing was stored anywhere. Say so — the one thing this path must never do is
      // let the editor keep looking saved.
      if (onScreen) {
        setSaveError(
          outcome.status === 'unavailable'
            ? 'Not saved — your Companion is unreachable and this device has no offline queue.'
            : `Not saved — ${outcome.message}`,
        );
      }

      return false;
    },
    [],
  );

  useEffect(() => {
    // The appliance served this note back, so the drain landed and its id is no longer
    // owed. Later edits belong on the ordinary online path.
    if (id && id !== 'new' && note?.id) {
      forgetQueuedNote(id);
      setQueuedSnapshot(null);
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

  // Closing or reloading the tab loses whatever Memory does not have yet. Inside the app,
  // leaving still sends an edit that is only waiting for the debounce (see the flush
  // below), so it asks when that is not enough: a save is out and may still fail, or one
  // already failed.
  const leaveGuard = useLeaveGuard({
    unsaved: isDirty || saving,
    ask: isDirty && (saving || saveError !== null || retry !== null || changedElsewhere),
  });

  /** Memory holds `content` for `s`'s note, as of `updatedAt` when the answer said. */
  const stored = (s: SaveSession, content: string | null, updatedAt: string | null | undefined) => {
    s.held = content;
    s.retrying = false;
    s.baseUpdatedAt = updatedAt ?? s.baseUpdatedAt;
    rememberContent(s, content);

    if (isCurrent(s)) {
      setRetry(null);
      setSaveError(null);
      // Typed while the save was out: not saved yet (`sendRest` sends it).
      setIsDirty(s.content !== content);
    }
  };

  /** `content` is in this device's offline queue (`queueSnapshot` already said so). */
  const queued = (s: SaveSession, content: string) => {
    s.held = content;
    s.retrying = false;

    if (isCurrent(s)) {
      setRetry(null);
      setIsDirty(s.content !== content);
    }
  };

  /** The save never reached Memory and nothing stored it, so it waits to be sent again. */
  const failed = (s: SaveSession) => {
    s.retrying = true;
    // What the write guard does when it refuses a write: the connection check can be up
    // to a re-probe interval old, and noticing the outage now is what makes the return a
    // change it reports (see the connection effect below).
    requestConnectionRefresh();

    if (isCurrent(s)) {
      setRetry((current) => ({ attempt: current ? current.attempt + 1 : 0 }));
    }
  };

  /**
   * Memory answered and would not store it. Sending the same save again gets the same
   * answer, so a save waiting to go again stops waiting, and the toolbar says why.
   */
  const refused = (s: SaveSession, message: string) => {
    s.retrying = false;

    if (isCurrent(s)) {
      setRetry(null);
      setSaveError(message);
    }
  };

  /** A save that threw and that nothing queued: refused if Memory said no, else out of reach. */
  const failedOrRefused = (s: SaveSession, error: unknown) => {
    const status = refusedStatus(error);

    if (status === null) {
      failed(s);
    } else {
      refused(s, `Not saved. Memory turned this save down (${status}).`);
    }
  };

  /**
   * A retry was refused because the note changed after this page last saw it. If Memory
   * now holds text this page loaded or sent, the change was this page's own save landing
   * late, so the newest text goes again against that version. Anything else was written
   * somewhere else, and this page stops saving rather than put an older edit over it.
   */
  const movedOn = (s: SaveSession, current: { content?: string | null; updatedAt: string }) => {
    const content = current.content ?? null;

    if (content !== null && s.known.includes(content)) {
      stored(s, content, current.updatedAt);

      return content === s.content ? 'rest' : 'again';
    }

    s.changedElsewhere = true;
    s.retrying = false;

    if (isCurrent(s)) {
      setRetry(null);
      setChangedElsewhere(true);
    }

    return null;
  };

  /** After a save landed or queued: send what was typed while it was out, without waiting for another keystroke. */
  const sendRest = (s: SaveSession) => {
    if (
      s.inFlight === 0 &&
      s.timer === null &&
      !s.retrying &&
      !s.changedElsewhere &&
      s.content !== null &&
      s.content !== s.held
    ) {
      s.timer = setTimeout(() => {
        s.timer = null;
        void saveRef.current(s);
      }, 0);
    }
  };

  /**
   * Save what `s`'s editor holds. A `retry` is a failed save sent again on its own: it
   * holds an edit typed before the failure, so it only writes over the version of the
   * note this page last saw.
   */
  const save = async (s: SaveSession, mode: 'typed' | 'retry' = 'typed') => {
    const content = s.content;

    if (content === null || s.changedElsewhere) {
      return;
    }

    // A new note's first save is still out, and nothing can be written under its id until
    // it lands. What is typed meanwhile goes out right after it (`sendRest`).
    if (s.serverId === null && s.inFlight > 0) {
      return;
    }

    const title = extractTitle(content);
    // When the save is SENT, for a snapshot queued if it fails (see `queueSnapshot`).
    const sentAt = Date.now();
    let next: 'rest' | 'again' | null = null;

    if (s.serverId === null && s.routeId === 'new') {
      // Emptied before its first save landed (a failed one waiting to go again included):
      // there is nothing to create, now or on leaving (the flush comes through here too).
      if (!hasContent(content)) {
        s.retrying = false;

        if (isCurrent(s)) {
          setRetry(null);
          setSaveError(null);
        }

        return;
      }

      const draftId = (s.draftId ??= newNoteId());

      // The editor session is the page's, so only a note still on screen may claim it.
      if (editorSessionRef.current && isCurrent(s)) {
        claimMintedNote(editorSessionRef.current, draftId);
      }

      s.inFlight += 1;
      rememberContent(s, content);

      try {
        const result = await createNote({
          variables: {
            input: {
              id: GlobalUID.encode('note', draftId),
              content,
              title,
            },
          },
        }).finally(countAnswer);

        const created = result.data?.createNote;

        if (created?.success && created.note) {
          const createdNote = created.note;
          const newId = GlobalUID.parse('note', createdNote.id);

          s.serverId = createdNote.id;
          // A create sent again answers with the note as first stored, which can be older
          // than `content`; `sendRest` then sends the rest.
          stored(s, createdNote.content ?? null, createdNote.updatedAt);
          next = 'rest';

          if (isCurrent(s)) {
            if (editorSessionRef.current) {
              claimMintedNote(editorSessionRef.current, newId);
            }

            leaveGuard.allow(() => navigate(`/notes/${newId}`, { replace: true }));
          }
        } else {
          refused(s, 'Not saved. Memory refused this note.');
        }
      } catch (e) {
        console.error('Failed to create note', e);

        // The appliance is out of reach. The id was minted before the first try, so it is
        // the note's real and permanent id: the navigate below goes to the note's final
        // URL, and a create that lands late is the same note as the queued one.
        if (await queueSnapshot(s, draftId, title, content, sentAt)) {
          s.routeId = draftId;
          s.authored = true;
          queued(s, content);
          next = 'rest';

          if (isCurrent(s)) {
            leaveGuard.allow(() => navigate(`/notes/${draftId}`, { replace: true }));
          }
        } else {
          failedOrRefused(s, e);
        }
      } finally {
        s.inFlight -= 1;
      }
    } else if (s.serverId !== null) {
      const serverId = s.serverId;
      // A save typed while a failed one waits to go again holds that older edit too (the
      // editor's whole text goes each time), so it carries the same guard.
      const expectedUpdatedAt = mode === 'retry' || s.retrying ? s.baseUpdatedAt : null;

      s.inFlight += 1;
      rememberContent(s, content);

      try {
        const result = await updateNote({
          variables: {
            input: {
              id: serverId,
              content,
              title,
              ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
            },
          },
        }).finally(countAnswer);

        const payload = result.data?.updateNote;

        if (payload?.success) {
          stored(s, content, payload.note?.updatedAt);
          next = 'rest';

          if (isCurrent(s)) {
            // The appliance holds this text now. A snapshot queued by an earlier failed
            // save is older than it (see `queueSnapshot`), so "Saved offline" no longer
            // describes the note; nothing else clears it while the note id stays the same.
            setQueuedSnapshot(null);
          }
        } else if (payload?.note) {
          next = movedOn(s, payload.note);
        } else {
          refused(s, 'Not saved. This note is no longer in your Memory.');
        }
      } catch (e) {
        console.error('Failed to save note', e);

        // Safe to queue: the appliance served this note, so the editor is holding its
        // true content and a snapshot cannot overwrite anything with less than it had.
        if (await queueSnapshot(s, GlobalUID.parse('note', serverId), title, content, sentAt)) {
          queued(s, content);
          next = 'rest';
        } else {
          failedOrRefused(s, e);
        }
      } finally {
        s.inFlight -= 1;
      }
    } else if (s.authored && s.routeId) {
      // A note this page created while offline. Still ours, still complete.
      if (await queueSnapshot(s, s.routeId, title, content)) {
        queued(s, content);
        next = 'rest';
      } else {
        failed(s);
      }
    } else if (s.routeId && isCurrent(s)) {
      // The note did not load and this page never authored it, so whatever the editor is
      // showing is not the note. Queueing that would replace the real content with an
      // empty document — and `captured_at` would not save us, because the empty snapshot
      // genuinely is the newer one. Refuse, and say why.
      setSaveError(
        isQueuedNote(s.routeId)
          ? 'Queued — this note is waiting to sync and cannot be edited until it does.'
          : 'Not saved — this note could not be loaded, so changes cannot be queued.',
      );
    }

    if (next === 'again') {
      void saveRef.current(s, 'retry');
    } else if (next === 'rest') {
      sendRest(s);
    }
  };

  const saveRef = useRef(save);

  saveRef.current = save;

  // Send a failed save again, unless one is already out or about to go.
  const retryNow = useCallback(() => {
    const s = saveSessionRef.current;

    if (s && s.retrying && s.inFlight === 0 && s.timer === null) {
      void saveRef.current(s, 'retry');
    }
  }, []);

  useEffect(() => {
    if (!retry) {
      return;
    }

    const timer = setTimeout(retryNow, Math.min(RETRY_FIRST_MS * 2 ** retry.attempt, RETRY_MAX_MS));

    const whenShown = () => {
      if (document.visibilityState === 'visible') {
        retryNow();
      }
    };

    window.addEventListener('online', retryNow);
    window.addEventListener('focus', retryNow);
    document.addEventListener('visibilitychange', whenShown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', retryNow);
      window.removeEventListener('focus', retryNow);
      document.removeEventListener('visibilitychange', whenShown);
    };
  }, [retry, retryNow]);

  // The connection check, the same one behind the connection chip and the offline
  // queue's drain, found Memory again.
  const connectionMode = useOptionalConnectionMode()?.mode;
  const lastConnectionModeRef = useRef(connectionMode);

  useEffect(() => {
    const was = lastConnectionModeRef.current;

    lastConnectionModeRef.current = connectionMode;

    if (connectionMode === 'connected' && was !== 'connected') {
      retryNow();
    }
  }, [connectionMode, retryNow]);

  // Leaving a note, for another note or another page: send what it still owes now, an
  // edit waiting for the debounce or a failed save waiting to go again, the way the save
  // itself would have. `save` leaves the page alone once the note is off screen. Keyed on
  // the editor session rather than the route id, which changes when a new note moves to
  // its id while its first save may still owe the rest (`sendRest` sends that).
  useEffect(() => {
    const leaving = session;

    return () => {
      const owed = leaving.timer !== null || leaving.retrying;

      if (leaving.timer) {
        clearTimeout(leaving.timer);
        leaving.timer = null;
      }

      if (owed) {
        void saveRef.current(leaving, leaving.retrying ? 'retry' : 'typed');
      }

      // What the toolbar said about that note does not carry over to the next one, nor
      // does the question before leaving it.
      setIsDirty(false);
      setSaveError(null);
      setRetry(null);
      setChangedElsewhere(false);
    };
    // Once per editor session; `session` is that session's object.
  }, [editorKey]);

  const displayTitle = note?.title ?? localTitle;

  usePageTitle(displayTitle ? `Note - ${displayTitle} - Companion Memory` : 'Note - Companion Memory');

  const handleUpdate = (content: string) => {
    const s = session;

    s.content = content;

    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }

    // A new note with nothing in it has nothing to save, or to warn about, and a failed
    // first save waiting to go again has nothing left to create.
    if (s.serverId === null && s.routeId === 'new' && !hasContent(content)) {
      s.retrying = false;
      setRetry(null);
      setSaveError(null);
      setIsDirty(false);

      return;
    }

    setIsDirty(true);

    s.timer = setTimeout(() => {
      s.timer = null;
      void saveRef.current(s);
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
                {changedElsewhere ? (
                  // A retry found a version of the note this page never saw. The text stays
                  // in the editor; reloading shows the other version.
                  <>
                    <TriangleAlert className="text-destructive h-4 w-4" strokeWidth={1.5} />
                    <div>
                      Not saved.
                      <span className={STATUS_WORDS}>
                        {' '}
                        This note was changed somewhere else. Copy your text, then reload.
                      </span>
                    </div>
                  </>
                ) : saveError && !retry ? (
                  <>
                    <TriangleAlert className="text-destructive h-4 w-4" strokeWidth={1.5} />
                    <div>{saveError}</div>
                  </>
                ) : retry || (saving && savingTooLong) ? (
                  // The text stays in the editor. A save that hangs can still land, or fail
                  // into the offline queue; one that failed is sent again on its own. Until
                  // one lands, say it is stuck. A phone's toolbar only has room for the first
                  // sentence.
                  <>
                    <TriangleAlert className="text-amber-300 h-4 w-4" strokeWidth={1.5} />
                    <div>
                      Not saved yet.<span className={STATUS_WORDS}> Your Companion isn't answering.</span>
                    </div>
                  </>
                ) : saving ? (
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
      <AlertDialog
        open={leaveGuard.asking}
        onOpenChange={(open) => {
          if (!open) {
            leaveGuard.stay();
          }
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>Leave without saving?</AlertDialog.Title>
            <AlertDialog.Description>
              Memory hasn't saved your latest changes to this note. If you leave now, they may be lost.
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>Stay</AlertDialog.Cancel>
            <AlertDialog.Action
              // AlertDialog.Action renders the default button variant, so the destructive
              // styling has to come from here (as on the sign-out question).
              className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/60"
              onClick={leaveGuard.leave}
            >
              Leave
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}
