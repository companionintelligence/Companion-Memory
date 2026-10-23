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
  queries: [] as string[],
  navigate: vi.fn(),
}));

vi.mock('@/api/powersync/session', () => ({
  getReplicaDatabase: () => ({}),
}));
vi.mock('@/api/powersync/localPeople', () => ({
  LOCAL_PEOPLE_PAGE_SIZE: 30,
  listLocalPeople: async (_db: unknown, query: string) => {
    h.queries.push(query);

    return h.people.map((person) => ({ ...person, occurredAt: null, relatedId: null, detail: null }));
  },
  countLocalPeople: async () => h.people.length,
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
    renderWithProviders(<LocalPeopleList />, { route: '/memory/people' });

    expect(await screen.findByText('Brianne Paul')).toBeInTheDocument();
    expect(screen.getByText('Unnamed')).toBeInTheDocument();
    expect(screen.getByTestId('local-people-caption')).toHaveTextContent('Saved on this phone');
    expect(screen.getByText('2')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Brianne Paul'));
    expect(h.navigate).toHaveBeenCalledWith('/memory/saved/person/p1');
  });

  it("passes the header box's search through and says when no one matches", async () => {
    h.people = [];
    h.queries = [];
    renderWithProviders(<LocalPeopleList />, { route: '/memory/people?search=zed' });

    expect(await screen.findByText('No one saved on this phone matches')).toBeInTheDocument();
    expect(h.queries).toContain('zed');
  });
});
