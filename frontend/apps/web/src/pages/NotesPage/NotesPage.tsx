import { type ReactNode, useCallback, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, useDeviceLayout, usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Plus } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { ErrorState } from '@/components/ErrorState';
import { NoteIcon } from '@/components/icons';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { gql } from '@/graphql';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';

import { DeleteNoteModal } from './DeleteNoteModal';
import { Note } from './Note';

/** The rest now arrives by scrolling instead of being silently withheld past this many. */
export const PAGE_SIZE = 50;

export const GET_NOTES = gql(`
  query GetNotes($first: Int, $after: String) {
    notes(first: $first, after: $after) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          ...NoteGridItemFragment
        }
      }
    }
  }
`);

export function NotesPage() {
  usePageTitle('Notes - Companion Memory');

  const { isMobile } = useDeviceLayout();

  // GraphQL, not PowerSync. The list was a local watched query, but this
  // deployment has no PowerSync service, so isLoading never cleared.
  const { data, loading, error, refetch, fetchMore } = useQuery(GET_NOTES, {
    variables: { first: PAGE_SIZE },
  });

  const [focusedNote, setFocusedNote] = useState<string | null>(null);

  const handleDelete = (e: React.MouseEvent, noteId: string) => {
    e.preventDefault();
    e.stopPropagation();

    setFocusedNote(noteId);
  };

  const notes = data?.notes.edges.map((edge) => edge.node) || [];

  const fetchNextPage = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
        updateQuery: (prev, { fetchMoreResult }) => {
          if (!fetchMoreResult?.notes) {
            return prev;
          }

          const prevEdges = prev.notes?.edges ?? [];
          const seen = new Set(prevEdges.map((edge) => edge.cursor));
          const nextEdges = fetchMoreResult.notes.edges.filter((edge) => !seen.has(edge.cursor));

          return {
            notes: {
              ...fetchMoreResult.notes,
              edges: [...prevEdges, ...nextEdges],
            },
          };
        },
      }),
    [fetchMore],
  );

  const pagination = useInfiniteConnection({
    connection: data?.notes,
    loadedCount: notes.length,
    fetchNextPage,
  });

  let content: ReactNode;

  if (loading) {
    content = <LoadingPage />;
  } else if (error && notes.length === 0) {
    // `error` was never destructured, so a failed query fell through to the
    // empty state below — telling the owner they have zero notes over a
    // request that errored. The empty state is a CLAIM about their data; only
    // make it when the data actually arrived.
    content = (
      <ErrorState
        title="Could not load notes"
        description="Your notes are still here — this device could not reach them just now."
        onRetry={() => void refetch()}
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
      <div className="flex flex-col gap-4">
        <div className="grid w-full gap-4 justify-center grid-cols-[repeat(auto-fill,300px)] auto-rows-[300px]">
          {notes.map((note) => (
            <Note key={note.id} note={note} onDelete={(e) => handleDelete(e, note.id)} />
          ))}
        </div>

        <InfiniteListFooter pagination={pagination} noun="notes" />
      </div>
    );
  }

  return (
    <>
      <PageContent ref={pagination.scrollRef} className="p-2 gap-2 device:p-3 device:gap-3">
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
          {content}
        </MemoryHubShell>
      </PageContent>

      {focusedNote && <DeleteNoteModal noteId={focusedNote} onClose={() => setFocusedNote(null)} />}
    </>
  );
}
