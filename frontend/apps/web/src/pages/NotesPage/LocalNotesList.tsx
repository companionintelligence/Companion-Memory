import { type ReactNode, useState } from 'react';

import { EmptyState, GlobalUID, LoadingPage, useDeviceLayout, usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Plus } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { deleteLocalNote, useLocalNotes } from '@/api/powersync/localNotes';
import { getReplicaDatabase } from '@/api/powersync/session';
import { ErrorState } from '@/components/ErrorState';
import { NoteIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import type { FragmentType } from '@/graphql/fragment-masking';

import { DeleteNoteModal } from './DeleteNoteModal';
import { Note, type NoteGridItemFragment } from './Note';

/**
 * The notes on a phone with a synced replica: the local `notes` table,
 * watched, so a note written here or arriving from the appliance shows at
 * once, online or off. A delete is a local delete that PowerSync carries
 * to the appliance. No paging: the table is one user's notes, in full.
 */
export function LocalNotesList() {
  usePageTitle('Notes - Companion Memory');

  const { isMobile } = useDeviceLayout();
  const { data: notes, isLoading, error, refresh } = useLocalNotes();
  const [focusedNote, setFocusedNote] = useState<string | null>(null);

  let content: ReactNode;

  if (isLoading && notes.length === 0) {
    content = <LoadingPage />;
  } else if (error && notes.length === 0) {
    content = (
      <ErrorState
        title="Could not load notes"
        description="This phone's copy of your notes could not be read just now."
        onRetry={() => void refresh?.()}
      />
    );
  } else if (notes.length === 0) {
    content = (
      <EmptyState
        icon={<NoteIcon size={48} colorized={false} />}
        message={
          <>
            <div>You don't have any notes yet.</div>
            <Link to="/notes/new">
              <Button>Create note</Button>
            </Link>
          </>
        }
      />
    );
  } else {
    content = (
      <div
        data-testid="notes-list"
        className="grid w-full grid-cols-1 gap-1.5 device:auto-rows-[300px] device:grid-cols-[repeat(auto-fill,300px)] device:justify-center device:gap-4"
      >
        {notes.map((note) => (
          <Note
            key={note.id}
            // The row reads the GraphQL shape; a local row carries the same
            // three fields, with the id in the global form the link decodes.
            note={
              {
                id: GlobalUID.encode('note', note.id),
                title: note.title,
                content: note.content,
              } as FragmentType<typeof NoteGridItemFragment>
            }
            onDelete={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setFocusedNote(note.id);
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <PageContent className="gap-2 p-0 device:gap-4">
        <MemoryHubShell
          actions={
            isMobile ? undefined : (
              <Link to="/notes/new">
                <Button size="sm">
                  <Plus className="h-4 w-4" />
                  New note
                </Button>
              </Link>
            )
          }
        >
          <div data-testid="notes-content-inset" className="px-2 pb-3 device:px-4 device:pb-4">
            {content}
          </div>
        </MemoryHubShell>
      </PageContent>

      {focusedNote && (
        <DeleteNoteModal
          noteId={GlobalUID.encode('note', focusedNote)}
          onClose={() => setFocusedNote(null)}
          onDelete={async () => {
            const database = getReplicaDatabase();

            if (!database) {
              throw new Error('No local copy to delete from');
            }

            await deleteLocalNote(database, focusedNote);
          }}
        />
      )}
    </>
  );
}
