import { Sheet } from '@ci/shadcn';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { EntityDrawerHostProvider } from './drawerHost';
import { GET_DRAWER_NODE, ResolvedGenericDetails } from './ResolvedGenericDetails';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

// The relationship cards need the auth context for the REST graph endpoints; the drawer body is what's under test.
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const CONTENT_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6f1';
const CONTENT_GLOBAL_ID = btoa(`content:${CONTENT_UUID}`);

const host = { setActiveEntity: vi.fn(), refetch: vi.fn() };

describe('ResolvedGenericDetails', () => {
  /**
   * Regression: opening a relationship card pushed a {id, type, name} stub and
   * the drawer rendered only "Type: Content" for it. The stub must be resolved
   * to the full node so the typed details body (with text, media, link…) shows.
   */
  it('resolves a graph-node stub to the full typed details body', async () => {
    renderWithProviders(
      <EntityDrawerHostProvider value={host}>
        <Sheet open>
          <ResolvedGenericDetails
            entity={{ __typename: 'GenericEntity', id: CONTENT_UUID, entityType: 'content', name: 'stub' }}
          />
        </Sheet>
      </EntityDrawerHostProvider>,
      {
        mocks: [
          {
            request: { query: GET_DRAWER_NODE, variables: { id: CONTENT_GLOBAL_ID } },
            result: {
              data: {
                node: {
                  __typename: 'ContentType' as const,
                  id: CONTENT_GLOBAL_ID,
                  tags: [],
                  galleryMimetype: 'text/html',
                  galleryTitle: 'Pier article',
                  galleryContentUrl: 'https://example.test/pier',
                  galleryContentSourceUrl: null,
                  galleryPreviewUrl: null,
                  galleryFileUrl: null,
                  galleryMediaSize: null,
                  title: 'Pier article',
                  text: 'Long read about the pier',
                  contentUrl: 'https://example.test/pier',
                  sourceUrl: null,
                  mimetype: 'text/html',
                  mediaUrl: null,
                  previewUrl: null,
                },
              },
            },
          },
        ],
      },
    );

    // Stub first, full body once the node lands.
    expect(await screen.findByRole('heading', { name: 'Pier article' })).toBeInTheDocument();
    expect(screen.getByText('Long read about the pier')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://example.test/pier' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('keeps the stub view for a type with no GraphQL node', () => {
    renderWithProviders(
      <EntityDrawerHostProvider value={host}>
        <Sheet open>
          <ResolvedGenericDetails
            entity={{ __typename: 'GenericEntity', id: 'x', entityType: 'mystery', name: 'Odd node' }}
          />
        </Sheet>
      </EntityDrawerHostProvider>,
      { mocks: [] },
    );

    expect(screen.getByRole('heading', { name: 'Odd node' })).toBeInTheDocument();
  });
});
