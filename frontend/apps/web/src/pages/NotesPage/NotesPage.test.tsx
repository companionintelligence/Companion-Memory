import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_NOTES, NotesPage, PAGE_SIZE } from './NotesPage';

// The hub nav reads providers the harness deliberately does not supply, but the
// `actions` slot (the "New note" button) is exactly what the create-action
// tests below are about, so render it instead of swallowing it — see
// MobileMemoryPage.test.tsx for the same pattern.
vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children, actions }: { children?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));

const NOTE_A = btoa('note:a');
const NOTE_B = btoa('note:b');

function makeNote(id: string, title: string) {
  return {
    __typename: 'NoteType' as const,
    id,
    title,
    content: '<p>Milk, eggs, bread</p>',
  };
}

function notesResult(
  nodes: ReturnType<typeof makeNote>[],
  overrides: { totalCount?: number; hasNextPage?: boolean; endCursor?: string | null } = {},
) {
  return {
    notes: {
      __typename: 'NoteConnection' as const,
      totalCount: overrides.totalCount ?? nodes.length,
      pageInfo: {
        __typename: 'PageInfo' as const,
        hasNextPage: overrides.hasNextPage ?? false,
        endCursor: overrides.endCursor ?? null,
      },
      edges: nodes.map((node) => ({ __typename: 'NoteEdge' as const, cursor: node.id, node })),
    },
  };
}

describe('NotesPage', () => {
  it('renders notes returned by the query', async () => {
    renderWithProviders(<NotesPage />, {
      mocks: [mockQuery(GET_NOTES, { first: PAGE_SIZE }, notesResult([makeNote(NOTE_A, 'Grocery list')]))],
    });

    expect(await screen.findByText('Grocery list')).toBeInTheDocument();
  });

  describe('error handling', () => {
    /**
     * `error` used to never be destructured, so a failed query fell through to
     * `notes.length === 0` and rendered the same confident "you have none yet"
     * empty state a genuinely empty account gets — actively misleading during
     * a real outage. It must render the shared ErrorState instead, with a
     * working retry, and the two must be visibly distinct.
     */
    it('shows the shared ErrorState with a working retry when the query fails, not the empty state', async () => {
      renderWithProviders(<NotesPage />, {
        mocks: [
          {
            request: { query: GET_NOTES, variables: { first: PAGE_SIZE } },
            error: new Error('network down'),
          },
          // Consumed only after the retry click.
          mockQuery(GET_NOTES, { first: PAGE_SIZE }, notesResult([makeNote(NOTE_A, 'Grocery list')])),
        ],
      });

      expect(await screen.findByText('Could not load notes')).toBeInTheDocument();
      expect(
        screen.getByText('Your notes are still here — this device could not reach them just now.'),
      ).toBeInTheDocument();
      expect(screen.queryByText("You don't have any notes yet.")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByText('Grocery list')).toBeInTheDocument();
    });

    it('shows the genuine empty state — distinct from the error state — when there really are zero notes', async () => {
      renderWithProviders(<NotesPage />, {
        mocks: [mockQuery(GET_NOTES, { first: PAGE_SIZE }, notesResult([]))],
      });

      expect(await screen.findByText("You don't have any notes yet.")).toBeInTheDocument();
      expect(screen.queryByText('Could not load notes')).not.toBeInTheDocument();
    });
  });

  describe('pagination', () => {
    /**
     * `GET_NOTES` used to be called with a fixed `first: 50` and never read
     * `pageInfo`/`hasNextPage` — a 51st note was silently invisible with no
     * sign anything was cut off.
     */
    it('says how many of the counted notes are actually listed, instead of silently stopping at the page size', async () => {
      renderWithProviders(<NotesPage />, {
        mocks: [
          mockQuery(
            GET_NOTES,
            { first: PAGE_SIZE },
            notesResult([makeNote(NOTE_A, 'Grocery list')], {
              totalCount: 120,
              hasNextPage: true,
              endCursor: NOTE_A,
            }),
          ),
        ],
      });

      expect(await screen.findByText('Grocery list')).toBeInTheDocument();

      const status = screen.getByText(/loaded/).textContent;

      expect(status).toContain('1 of 120 loaded');
      expect(status).not.toContain('end');
    });

    it('marks the end once every note has actually been fetched', async () => {
      renderWithProviders(<NotesPage />, {
        mocks: [
          mockQuery(
            GET_NOTES,
            { first: PAGE_SIZE },
            notesResult([makeNote(NOTE_A, 'Grocery list'), makeNote(NOTE_B, 'Trip notes')], {
              totalCount: 2,
              hasNextPage: false,
            }),
          ),
        ],
      });

      expect(await screen.findByText('Grocery list')).toBeInTheDocument();
      expect(screen.getByText(/loaded/).textContent).toContain('2 of 2 loaded · end');
    });
  });

  describe('create action', () => {
    it('shows New note on desktop when the list is populated', async () => {
      renderWithProviders(<NotesPage />, {
        mocks: [mockQuery(GET_NOTES, { first: PAGE_SIZE }, notesResult([makeNote(NOTE_A, 'Grocery list')]))],
      });

      expect(await screen.findByText('Grocery list')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /New note/ })).toBeInTheDocument();
    });

    it('still shows New note on desktop when the list is empty — it used to disappear with the empty state', async () => {
      renderWithProviders(<NotesPage />, {
        mocks: [mockQuery(GET_NOTES, { first: PAGE_SIZE }, notesResult([]))],
      });

      expect(await screen.findByText("You don't have any notes yet.")).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /New note/ })).toBeInTheDocument();
    });
  });
});
