import { ApolloClient, ApolloProvider, InMemoryCache } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import type { Decorator } from '@storybook/react';

import type { FragmentType } from '@/graphql';

import type { SavedSearchGridItemFragment } from './SavedSearch';

// A throwaway Apollo client so the saved-search modals (which call useMutation)
// render in Storybook. Mutations only fire on interaction, so a no-op link is
// fine for capturing the rendered UI.
const storyClient = new ApolloClient({
  uri: '/graphql',
  cache: new InMemoryCache(),
  connectToDevTools: false,
});

export const withApollo: Decorator = (Story) => (
  <ApolloProvider client={storyClient}>
    <Story />
  </ApolloProvider>
);

/**
 * A plausible saved-search shaped like SavedSearchGridItemFragment. useFragment is
 * runtime-identity, so the modals/card accept this directly as the masked prop.
 */
export function mockSavedSearch(
  overrides: Record<string, unknown> = {},
): FragmentType<typeof SavedSearchGridItemFragment> {
  return {
    __typename: 'SavedSearchType',
    id: GlobalUID.encode('saved-search', '0190a0c0-0000-7000-8000-000000000001'),
    name: 'Paris trip — photos',
    description: 'Photos and visits from the Paris trip, located only.',
    query: 'paris',
    entityTypes: ['event', 'file'],
    tags: ['travel'],
    filters: {
      __typename: 'SavedSearchFiltersType',
      eventTypes: ['visited'],
      startTime: '2024-06-01T00:00:00.000Z',
      endTime: '2024-06-30T23:59:59.999Z',
      datePreset: null,
      sortBy: 'time',
      sortOrder: 'desc',
      connectors: ['google-photos'],
      people: ['Alex'],
      places: ['Paris'],
      hasLocation: true,
      semantic: null,
    },
    isPublic: true,
    shareToken: 'b6f3a1c20d9e4f7a8c1b2d3e4f5a6b7c',
    ...overrides,
  } as unknown as FragmentType<typeof SavedSearchGridItemFragment>;
}
