import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  notes: [] as Array<{
    id: string;
    title: string | null;
    content: string | null;
    created_at: string;
    updated_at: string;
  }>,
  execute: vi.fn(async () => undefined),
}));

vi.mock('@/api/powersync/replicaQuery', () => ({
  useReplicaQuery: () => ({ data: h.notes, isLoading: false, error: undefined, refresh: vi.fn() }),
}));

vi.mock('@/api/powersync/session', () => {
  // One object for the life of the test: the page reads the binding through a store
  // (`useReplicaDatabase`), and a store whose snapshot is new on every read never settles.
  const replica = {
    get execute() {
      return h.execute;
    },
  };

  return {
    getReplicaDatabase: () => replica,
    subscribeBoundDatabase: () => () => undefined,
  };
});

vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children, actions }: { children?: React.ReactNode; actions?: React.ReactNode }) => (
    <div>
      {actions}
      {children}
    </div>
  ),
}));

import { NotesPage } from './NotesPage';

describe('NotesPage on a phone with a replica', () => {
  it('lists the phone’s notes from the local table and links each to its note', () => {
    h.notes = [
      {
        id: 'n1',
        title: 'Groceries',
        content: '<p>eggs</p>',
        created_at: '2026-01-01',
        updated_at: '2026-01-02',
      },
      {
        id: 'n2',
        title: 'Packing',
        content: '<p>socks</p>',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
    ];
    renderWithProviders(<NotesPage />, { route: '/notes' });

    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Packing')).toBeInTheDocument();
    expect(screen.getByText('Groceries').closest('a')).toHaveAttribute('href', '/notes/n1');
  });

  it('deletes locally, through the same dialog', async () => {
    h.notes = [
      { id: 'n1', title: 'Groceries', content: null, created_at: '2026-01-01', updated_at: '2026-01-02' },
    ];
    renderWithProviders(<NotesPage />, { route: '/notes' });

    fireEvent.click(screen.getAllByRole('button', { name: /delete/i })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(h.execute).toHaveBeenCalledWith('DELETE FROM notes WHERE id = ?', ['n1']));
  });

  it('offers to create when the phone holds no notes', () => {
    h.notes = [];
    renderWithProviders(<NotesPage />, { route: '/notes' });

    expect(screen.getByText("You don't have any notes yet.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create note' })).toBeInTheDocument();
  });
});
