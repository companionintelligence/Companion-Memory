import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  people: [] as Array<{
    id: string;
    entityType: string;
    entityId: string;
    title: string | null;
    body: string | null;
  }>,
  calls: [] as Array<{ entityType: string; order: string; query: string }>,
  navigate: vi.fn(),
}));

vi.mock('@/api/powersync/session', () => ({
  getReplicaDatabase: () => ({}),
}));

vi.mock('@/api/powersync/localTypeList', () => ({
  LOCAL_TYPE_LIST_PAGE_SIZE: 30,
  listLocalByType: async (_db: unknown, entityType: string, order: string, query: string) => {
    h.calls.push({ entityType, order, query });

    return h.people.map((person) => ({ ...person, occurredAt: null, relatedId: null, detail: null }));
  },
  countLocalByType: async () => h.people.length,
}));

vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));

import { LocalPeopleList } from './LocalPeopleList';

describe('LocalPeopleList', () => {
  it("lists the phone's people with the caption and opens the saved record on tap", async () => {
    h.people = [
      {
        id: 'd1',
        entityType: 'person',
        entityId: 'p1',
        title: 'Brianne Paul',
        body: 'Brianne Paul {"names":["brianne paul"]}',
      },
      { id: 'd2', entityType: 'person', entityId: 'p2', title: null, body: null },
    ];
    h.calls = [];

    renderWithProviders(<LocalPeopleList />, { route: '/memory/people' });

    expect(await screen.findByText('Brianne Paul')).toBeInTheDocument();
    expect(screen.getByText('Unnamed')).toBeInTheDocument();
    expect(screen.getAllByTestId('local-person-row')).toHaveLength(2);
    expect(screen.getByTestId('local-type-caption')).toHaveTextContent('Saved on this phone');
    expect(screen.getByText('2')).toBeInTheDocument();
    // The people page is the per-type list with 'person', browsed by name.
    expect(h.calls).toEqual([{ entityType: 'person', order: 'title', query: '' }]);

    fireEvent.click(screen.getByText('Brianne Paul'));
    expect(h.navigate).toHaveBeenCalledWith('/memory/saved/person/p1');
  });

  it("passes the header box's search through and says when no one matches", async () => {
    h.people = [];
    h.calls = [];

    renderWithProviders(<LocalPeopleList />, { route: '/memory/people?search=zed' });

    expect(await screen.findByText('No one saved on this phone matches')).toBeInTheDocument();
    expect(h.calls).toEqual([{ entityType: 'person', order: 'title', query: 'zed' }]);
  });
});
