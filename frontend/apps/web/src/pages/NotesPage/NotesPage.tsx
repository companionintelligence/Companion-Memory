import { type ReactNode, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { NoteIcon } from '@/components/icons';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

import { DeleteNoteModal } from './DeleteNoteModal';
import { Note } from './Note';

const GET_NOTES = gql(`
  query GetNotes($first: Int, $after: String) {
    notes(first: $first, after: $after) {
      edges {
        node {
          id
          ...NoteGridItemFragment
        }
      }
    }
  }
`);

export function NotesPage() {
  usePageTitle('Notes - Companion Intelligence');

  const { data, loading } = useQuery(GET_NOTES, {
    variables: { first: 50 },
  });

  const [focusedNote, setFocusedNote] = useState<string | null>(null);

  const handleDelete = (e: React.MouseEvent, noteId: string) => {
    e.preventDefault();
    e.stopPropagation();

    setFocusedNote(noteId);
  };

  const notes = data?.notes.edges.map((edge) => edge.node) || [];

  let content: ReactNode;

  if (loading) {
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
