import { type ReactNode, useState } from 'react';

import { EmptyState, GlobalUID, LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button } from '@ci/shadcn';
import { useQuery } from '@powersync/react';
import { Link } from 'react-router-dom';

import { NoteIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';

import { DeleteNoteModal } from './DeleteNoteModal';
import { Note, type NoteRow } from './Note';

export function NotesPage() {
  usePageTitle('Notes - Companion Intelligence');

  // First proof-of-concept read migrated from Apollo to a PowerSync watched query
  // (infrastructure/powersync/README.md's stated "Next" step) — this re-runs
  // automatically whenever the local `notes` table changes, whether from this
  // device's own edits or a row synced down from the server. See
  // `@/api/powersync/schema.ts`/`connector.ts` for the table definition and write
  // path; `id` here is the raw note uuid, not the GraphQL global id.
  const { data: notes, isLoading } = useQuery<NoteRow>(
    'SELECT id, title, content FROM notes ORDER BY created_at DESC LIMIT 50',
  );

  const [focusedNote, setFocusedNote] = useState<string | null>(null);

  const handleDelete = (e: React.MouseEvent, noteId: string) => {
    e.preventDefault();
    e.stopPropagation();

    // DeleteNoteModal still deletes via the GraphQL `deleteNote` mutation, which
    // (like every other note mutation) expects the base64 global id, not the raw
    // uuid PowerSync's local row carries.
    setFocusedNote(GlobalUID.encode('note', noteId));
  };

  let content: ReactNode;

  if (isLoading) {
    content = <LoadingPage />;
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
      <PageContent>
        <div className="grid w-full gap-4 justify-center grid-cols-[repeat(auto-fill,300px)] auto-rows-[300px]">
          {notes.map((note) => (
            <Note key={note.id} note={note} onDelete={(e) => handleDelete(e, note.id)} />
          ))}
        </div>
      </PageContent>
    );
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            <Breadcrumb.Separator className="hidden md:block" />

            <Breadcrumb.Item>
              <Breadcrumb.Page>Notes</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {content}

      {focusedNote && <DeleteNoteModal noteId={focusedNote} onClose={() => setFocusedNote(null)} />}
    </>
  );
}
