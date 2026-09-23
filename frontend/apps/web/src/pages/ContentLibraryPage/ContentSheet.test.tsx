import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ContentSheet } from './ContentSheet';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

// The relationship cards need the auth context for the REST graph endpoints; the drawer body is what's under test.
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const GET_CONTENT_SHEET = gql(`
  query GetContentSheet($id: ID!) {
    content(id: $id) {
      __typename
      id
      tags {
        label
      }
      ...ContentGridItemData
      ...TableContentRowData
    }
  }
`);

const CONTENT_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6f1';
const CONTENT_GLOBAL_ID = btoa(`content:${CONTENT_UUID}`);

const contentMock = {
  request: { query: GET_CONTENT_SHEET, variables: { id: CONTENT_GLOBAL_ID } },
  result: {
    data: {
      content: {
        __typename: 'ContentType' as const,
        id: CONTENT_GLOBAL_ID,
        tags: [],
        title: 'Holiday photo',
        text: 'On the pier',
        mimetype: 'image/jpeg',
        contentUrl: 'https://example.test/pier',
        sourceUrl: null,
        previewUrl: null,
        mediaUrl: null,
        mediaFilename: null,
        mediaSize: null,
        sourceType: null,
        sourceSystem: null,
        sourceId: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        player: null,
        unfurl: null,
      },
    },
  },
};

describe('ContentSheet', () => {
  /**
   * Regression: the shared drawer body read the explorer's entity-service
   * context and threw outside it, so clicking a tile routed to
   * /memory/content/:id and nothing opened.
   */
  it('opens the details drawer for the routed content row', async () => {
    renderWithProviders(
      <ContentSheet contentId={CONTENT_GLOBAL_ID} onClose={vi.fn()} onChanged={vi.fn()} />,
      {
        mocks: [contentMock],
      },
    );

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Holiday photo' })).toBeInTheDocument();

    // The full-page control routes in place, never `target="_blank"`: a new tab
    // left the Capacitor build for Safari (issue #2311). See EntityDetailScaffold.
    const fullPage = screen.getByRole('link', { name: /open full page/i });

    expect(fullPage).toHaveAttribute('href', `/content/${CONTENT_UUID}`);
    expect(fullPage).not.toHaveAttribute('target');

    // The content's own web URL is genuinely external, so it still opens out.
    const external = screen.getByRole('link', { name: 'https://example.test/pier' });

    expect(external).toHaveAttribute('href', 'https://example.test/pier');
    expect(external).toHaveAttribute('target', '_blank');
  });

  it('renders nothing when no row is routed', () => {
    renderWithProviders(<ContentSheet contentId={null} onClose={vi.fn()} onChanged={vi.fn()} />, {
      mocks: [],
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
