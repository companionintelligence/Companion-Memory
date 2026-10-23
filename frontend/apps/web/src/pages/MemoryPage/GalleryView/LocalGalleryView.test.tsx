import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  documents: [] as Array<{
    id: string;
    entityType: string;
    entityId: string;
    title: string | null;
    detail: Record<string, unknown> | null;
  }>,
  sources: new Map<string, string>(),
  queries: [] as Array<Record<string, unknown>>,
  navigate: vi.fn(),
}));

vi.mock('@/api/powersync/session', () => ({ getReplicaDatabase: () => ({}) }));
vi.mock('@/api/powersync/localList', () => ({
  LOCAL_LIST_PAGE_SIZE: 30,
  listLocal: async (_db: unknown, query: Record<string, unknown>) => {
    h.queries.push(query);

    return { documents: h.documents.map((d) => ({ ...d, body: null, occurredAt: null, relatedId: null })) };
  },
}));
vi.mock('@/api/powersync/previews', () => ({
  isPreviewSyncEnabled: () => true,
  previewSources: async () => h.sources,
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => h.navigate,
}));

import { LocalGalleryView } from './LocalGalleryView';

describe('LocalGalleryView', () => {
  it('asks for the photos with a preview, newest first, draws the ones that arrived, and opens the saved record', async () => {
    h.documents = [
      { id: 'd1', entityType: 'content', entityId: 'c1', title: 'Beach', detail: { preview_id: 'f1' } },
      { id: 'd2', entityType: 'file', entityId: 'f2', title: null, detail: { preview_id: 'f2' } },
    ];
    h.sources = new Map([['f1', 'http://localhost/_capacitor_file_/previews/f1.jpg']]);
    renderWithProviders(<LocalGalleryView />, { route: '/memory?view=gallery&connectors=google_photos' });

    const tiles = await screen.findAllByTestId('local-gallery-tile');
    expect(tiles).toHaveLength(2);
    expect(h.queries[0]).toMatchObject({ hasPreview: true, sort: 'newest', connectors: ['google_photos'] });
    expect(tiles[0].querySelector('img')).toHaveAttribute(
      'src',
      'http://localhost/_capacitor_file_/previews/f1.jpg',
    );
    // The second preview has not arrived: the glyph, no request for bytes.
    expect(tiles[1].querySelector('img')).toBeNull();
    expect(screen.getByTestId('local-gallery-caption')).toHaveTextContent('Saved on this phone');

    fireEvent.click(tiles[0]);
    expect(h.navigate).toHaveBeenCalledWith('/memory/saved/content/c1');
  });

  it('says when nothing on the phone matches', async () => {
    h.documents = [];
    renderWithProviders(<LocalGalleryView />, { route: '/memory?view=gallery&search=zzz' });

    expect(await screen.findByText('No photos saved on this phone match')).toBeInTheDocument();
  });
});
