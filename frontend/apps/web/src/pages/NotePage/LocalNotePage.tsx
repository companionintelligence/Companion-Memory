import { useCallback, useEffect, useRef, useState } from 'react';

import { GlobalUID, LoadingPage, newNoteId, useDeviceLayout, usePageTitle } from '@ci/common';
import { Editor } from '@ci/editor';
import { Check, Smartphone, TriangleAlert } from '@ci/shadcn/icons';
import { useNavigate, useParams } from 'react-router-dom';
import TimeAgo from 'react-timeago';

import { createLocalNote, updateLocalNote, useLocalNote } from '@/api/powersync/localNotes';
import { getReplicaDatabase } from '@/api/powersync/session';
import { ChatWithAgentMenu } from '@/components/ChatWithAgent';
import { PageContent } from '@/components/layout';
import { namedChatContext } from '@/lib/agentChat';

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
const STATUS_WORDS = 'sr-only device:not-sr-only';

/**
 * A note on a phone with a synced replica: the phone's own copy, read from
 * and written to the local `notes` table, online or off. Every save is a
 * local write — instant, and durable on this device — that PowerSync
 * carries to the appliance when it can (`connector.ts`); the appliance's
 * edits arrive the same way and this page re-reads them. A new note is
 * minted here under its permanent id, so `/notes/new` becomes `/notes/<id>`
 * once and never changes again.
 */
export function LocalNotePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { reference, onReferenceClick } = useEntityReference();
  const { isMobile } = useDeviceLayout();
  const { data, isLoading } = useLocalNote(id);
  const note = data[0] ?? null;

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<string | null>(null);
  const isCreatingRef = useRef(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // One editor for a draft and the id it mints (see noteEditorSession).
  const editorSessionRef = useRef<NoteEditorSession | null>(null);
  const editorSession = (editorSessionRef.current ??= createNoteEditorSession(id));
  const editorKey = syncNoteEditorSession(id, editorSession);
  const editorShownForKeyRef = useRef<string | null>(null);
  const contentSeedRef = useRef<{ key: string; content?: string } | null>(null);

  const save = useCallback(async (noteId: string, content: string, isNew: boolean) => {
    const database = getReplicaDatabase();

    if (!database) {
      setSaveError('Not saved — this phone has no local copy to write to.');

      return false;
    }

    const title = extractTitle(content);

    try {
      if (isNew) {
        await createLocalNote(database, { id: noteId, title, content });
      } else {
        await updateLocalNote(database, { id: noteId, title, content });
      }

      setSavedAt(new Date().toISOString());
      setSaveError(null);
      setIsDirty(false);

      return true;
    } catch (error) {
      console.error('Failed to save note locally', error);
      setSaveError('Not saved — this phone could not write the note.');

      return false;
    }
  }, []);

  // Flush the last edit on unmount, as the appliance-backed page does.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current && contentRef.current !== null && id && id !== 'new') {
        clearTimeout(saveTimeoutRef.current);
        void save(id, contentRef.current, false);
      }
    };
  }, [id, save]);

  const displayTitle = note?.title ?? null;

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

      if (id === 'new') {
        if (isCreatingRef.current) {
          return;
        }

        isCreatingRef.current = true;

        try {
          const localId = newNoteId();

          if (await save(localId, content, true)) {
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

      if (id) {
        await save(id, content, false);
      }
    }, AUTOSAVE_THROTTLE_MS);
  };

  if (isLoading && id !== 'new' && editorShownForKeyRef.current !== editorKey) {
    return <LoadingPage />;
  }

  editorShownForKeyRef.current = editorKey;

  const contentSeed = (contentSeedRef.current = editorContentSeed(
    contentSeedRef.current,
    editorKey,
    note?.content ?? undefined,
  ));
  const updatedAt = savedAt ?? note?.updated_at ?? null;

  return (
    <Editor key={editorKey} content={contentSeed.content} onUpdate={handleUpdate} reference={reference}>
      <div className="flex h-full flex-col overflow-hidden">
        <Editor.Menu>
          <div className="flex w-full items-center justify-between gap-2">
            <div
              className="flex items-center gap-2 px-2 text-xs text-muted-foreground"
              data-testid="note-status"
            >
              {saveError ? (
                <>
                  <TriangleAlert className="text-destructive h-4 w-4" strokeWidth={1.5} />
                  <div>{saveError}</div>
                </>
              ) : isDirty ? (
                <>
                  <TriangleAlert className="text-amber-300 h-4 w-4" strokeWidth={1.5} />
                  {updatedAt ? (
                    <span className={STATUS_WORDS}>
                      <TimeAgo date={updatedAt} minPeriod={5} formatter={shortFormatter} />
                    </span>
                  ) : null}
                </>
              ) : id !== 'new' && updatedAt ? (
                // Saved on this phone, which is saved: PowerSync carries it on.
                <>
                  <Check className="text-[rgb(6,108,128)] h-4 w-4 -mr-0.5" />
                  <Smartphone className="h-4 w-4" strokeWidth={1.5} />
                  <span
                    className={STATUS_WORDS}
                    title="Saved on this phone. It syncs to your Companion automatically."
                  >
                    <TimeAgo date={updatedAt} minPeriod={5} formatter={shortFormatter} />
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
                  sourceId: GlobalUID.encode('note', note.id),
                })}
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
  );
}
