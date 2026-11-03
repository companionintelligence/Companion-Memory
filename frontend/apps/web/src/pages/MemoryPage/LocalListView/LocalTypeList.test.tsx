import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  documents: [] as Array<{
    id: string;
    entityType: string;
    entityId: string;
    title: string | null;
    body: string | null;
    occurredAt: string | null;
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

    return h.documents.map((document) => ({ ...document, relatedId: null, detail: null }));
  },
  countLocalByType: async () => h.documents.length,
}));
vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));

import { LocalTypeList } from './LocalTypeList';

describe('LocalTypeList', () => {
  it("lists the phone's records of the type with the caption and count, and opens the saved record on tap", async () => {
    h.documents = [
      {
        id: 'd1',
        entityType: 'place',
        entityId: 'pl1',
        title: 'Blue Bottle Coffee',
        body: 'Coffee shop · 66 Mint St',
        occurredAt: null,
      },
      { id: 'd2', entityType: 'place', entityId: 'pl2', title: null, body: null, occurredAt: null },
    ];
    h.calls = [];
    renderWithProviders(
      <LocalTypeList
        entityType="place"
        heading="Places"
        pageTitle="Places - Companion Memory"
        order="title"
      />,
      { route: '/memory/places' },
    );

    expect(await screen.findByText('Blue Bottle Coffee')).toBeInTheDocument();
    expect(screen.getByText('Unnamed place')).toBeInTheDocument();
    expect(screen.getByText('Places')).toBeInTheDocument();
    expect(screen.getByTestId('local-type-caption')).toHaveTextContent('Saved on this phone');
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(h.calls).toEqual([{ entityType: 'place', order: 'title', query: '' }]);

    fireEvent.click(screen.getByText('Blue Bottle Coffee'));
    expect(h.navigate).toHaveBeenCalledWith('/memory/saved/place/pl1');
  });

  it("passes the header box's search through, and the page's own parameter when that is what the URL has", async () => {
    h.documents = [];
    h.calls = [];
    const { unmount } = renderWithProviders(
      <LocalTypeList
        entityType="receipt"
        heading="Receipts"
        pageTitle="Receipts - Companion Memory"
        order="newest"
        searchParams={['search', 'q']}
      />,
      { route: '/memory/receipts?q=whole%20foods' },
    );

    expect(await screen.findByText('Nothing saved on this phone matches')).toBeInTheDocument();
    expect(h.calls).toEqual([{ entityType: 'receipt', order: 'newest', query: 'whole foods' }]);
    unmount();

    h.calls = [];
    renderWithProviders(
      <LocalTypeList
        entityType="receipt"
        heading="Receipts"
        pageTitle="Receipts - Companion Memory"
        order="newest"
        searchParams={['search', 'q']}
      />,
      { route: '/memory/receipts?search=target&q=ignored' },
    );

    await screen.findByText('Nothing saved on this phone matches');
    expect(h.calls).toEqual([{ entityType: 'receipt', order: 'newest', query: 'target' }]);
  });
});
