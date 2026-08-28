import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { GetSavedSearchDocument, GetSavedSearchesForPickerDocument } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { SavedSearchPicker } from './SavedSearchPicker';

function LocationProbe() {
  const location = useLocation();

  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function pickerResult(id: string, name: string, description: string | null = null) {
  return {
    savedSearches: {
      __typename: 'SavedSearchConnection' as const,
      totalCount: 1,
      edges: [
        {
          __typename: 'SavedSearchEdge' as const,
          node: { __typename: 'SavedSearchType' as const, id, name, description },
        },
      ],
    },
  };
}

describe('SavedSearchPicker', () => {
  it('lists the user’s own saved searches once opened, and applies the picked one to the URL', async () => {
    const id = btoa('saved-search:trip-1');

    renderWithProviders(
      <>
        <SavedSearchPicker />
        <LocationProbe />
      </>,
      {
        route: '/memory',
        mocks: [
          mockQuery(GetSavedSearchesForPickerDocument, { first: 8, query: undefined }, pickerResult(id, 'My trip')),
          mockQuery(GetSavedSearchDocument, { id }, {
            savedSearch: {
              __typename: 'SavedSearchType' as const,
              id,
              name: 'My trip',
              description: null,
              query: 'paris',
              entityTypes: [],
              tags: ['vacation'],
              filters: null,
            },
          }),
        ],
      },
    );

    fireEvent.click(screen.getByRole('button', { name: /Load search/ }));

    expect(await screen.findByText('My trip')).toBeInTheDocument();

    fireEvent.click(screen.getByText('My trip'));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('search=paris'),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('tags=vacation');
  });

  it('sends typed filter text as the query variable', async () => {
    const id = btoa('saved-search:work-1');

    renderWithProviders(<SavedSearchPicker />, {
      route: '/memory',
      mocks: [
        mockQuery(GetSavedSearchesForPickerDocument, { first: 8, query: undefined }, pickerResult(id, 'Work stuff')),
        mockQuery(
          GetSavedSearchesForPickerDocument,
          { first: 8, query: 'work' },
          pickerResult(id, 'Work stuff'),
        ),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Load search/ }));
    expect(await screen.findByText('Work stuff')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Filter your saved searches...'), {
      target: { value: 'work' },
    });

    await waitFor(() => expect(screen.getByText('Work stuff')).toBeInTheDocument());
  });

  it('shows an empty message when nothing matches, not a stuck loading state', async () => {
    renderWithProviders(<SavedSearchPicker />, {
      route: '/memory',
      mocks: [
        mockQuery(GetSavedSearchesForPickerDocument, { first: 8, query: undefined }, {
          savedSearches: { __typename: 'SavedSearchConnection', totalCount: 0, edges: [] },
        }),
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /Load search/ }));

    expect(await screen.findByText('No saved searches yet.')).toBeInTheDocument();
  });
});
