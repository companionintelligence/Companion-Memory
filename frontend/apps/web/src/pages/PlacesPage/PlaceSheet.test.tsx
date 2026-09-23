import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_PLACE_SHEET, PlaceSheet } from './PlaceSheet';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

// The relationship cards need the auth context for the REST graph endpoints;
// the drawer body is what's under test.
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const PLACE_UUID = '019fd7c0-641c-76dd-8ed7-a5053faff6f1';
const PLACE_GLOBAL_ID = btoa(`place:${PLACE_UUID}`);

const placeMock = {
  request: { query: GET_PLACE_SHEET, variables: { id: PLACE_GLOBAL_ID } },
  result: {
    data: {
      place: {
        __typename: 'PlaceType' as const,
        id: PLACE_GLOBAL_ID,
        tags: [],
        mapProperties: { address: '1 Pier Rd', latitude: 51.5, longitude: -0.1 },
        name: 'Bletchley Park',
        description: 'Where the codebreakers worked',
        properties: { address: '1 Pier Rd', latitude: 51.5, longitude: -0.1 },
      },
    },
  },
};

describe('PlaceSheet', () => {
  it('opens the shared details drawer for the routed place', async () => {
    renderWithProviders(<PlaceSheet placeId={PLACE_GLOBAL_ID} onClose={vi.fn()} onChanged={vi.fn()} />, {
      mocks: [placeMock],
    });

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Bletchley Park' })).toBeInTheDocument();
    expect(screen.getByText('Where the codebreakers worked')).toBeInTheDocument();

    // The full-page control routes in place, never `target="_blank"`: a new tab
    // left the Capacitor build for Safari (issue #2311). See EntityDetailScaffold.
    const fullPage = screen.getByRole('link', { name: /open full page/i });

    expect(fullPage).toHaveAttribute('href', `/places/${PLACE_UUID}`);
    expect(fullPage).not.toHaveAttribute('target');
  });

  it('renders nothing when no place is routed', () => {
    renderWithProviders(<PlaceSheet placeId={null} onClose={vi.fn()} onChanged={vi.fn()} />, { mocks: [] });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
