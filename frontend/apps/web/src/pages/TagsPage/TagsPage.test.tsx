import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useSearchParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { GET_TAGS_WITH_USAGE, TagsPage } from './TagsPage';

// TagsPage renders MemoryHubShell -> MemoryHubNav, which reads useFeatures.
// That hook fetches through useAuth on mount, and renderWithProviders
// deliberately does not supply Auth/Features context (see its own doc
// comment) — mock the module directly, same as ExplorerToolbar.test.tsx.
vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => false, loading: false, refresh: vi.fn() }),
}));

// Surfaces the live URL search params in the DOM so assertions can read the
// `?q=` state TagsPage writes without reaching into router internals.
function ParamsProbe() {
  const [params] = useSearchParams();

  return <div data-testid="params">{params.toString()}</div>;
}

interface TagNodeOverrides {
  id?: string;
  label?: string;
  description?: string | null;
  entityCount?: number;
}

function tagNode(overrides: TagNodeOverrides = {}) {
  return {
    __typename: 'TagType' as const,
    id: 't1',
    label: 'holiday',
    description: null,
    entityCount: 3,
    ...overrides,
  };
}

function tagsMock(nodes: ReturnType<typeof tagNode>[]): MockedResponse {
  return mockQuery(
    GET_TAGS_WITH_USAGE,
    {},
    {
      tags: {
        __typename: 'TagConnection' as const,
        edges: nodes.map((node) => ({ __typename: 'TagEdge' as const, node })),
      },
    },
  );
}

function renderTagsPage(mocks: MockedResponse[], route = '/tags') {
  return renderWithProviders(
    <>
      <ParamsProbe />
      <TagsPage />
    </>,
    { route, mocks },
  );
}

describe('TagsPage — search state lives in the URL', () => {
  it('reads the filter from the header search box\'s ?search= and applies it client-side', async () => {
    renderTagsPage(
      [tagsMock([tagNode({ id: 't1', label: 'holiday' }), tagNode({ id: 't2', label: 'work' })])],
      '/tags?search=holi',
    );

    // Filtering itself is unchanged: only a tag matching the URL's text shows.
    await waitFor(() => expect(screen.getByText('holiday')).toBeInTheDocument());
    expect(screen.queryByText('work')).not.toBeInTheDocument();
    // The page carries no input of its own — the header search box owns the text.
    expect(screen.queryByPlaceholderText('Filter tags...')).not.toBeInTheDocument();
  });
});

describe('TagsPage — error state uses the shared ErrorState component', () => {
  it('renders ErrorState (with Retry) instead of the old no-retry empty state, and Retry calls refetch', async () => {
    renderTagsPage([
      mockQuery(GET_TAGS_WITH_USAGE, {}, { error: new Error('network down') }),
      tagsMock([tagNode({ id: 't1', label: 'holiday' })]),
    ]);

    expect(await screen.findByText('Could not load tags')).toBeInTheDocument();
    expect(
      screen.getByText('Your tags are still here — this device could not reach them just now.'),
    ).toBeInTheDocument();

    // The old generic "Couldn't load tags: <message>" copy, which had no
    // retry, must be gone.
    expect(screen.queryByText(/Couldn't load tags:/)).not.toBeInTheDocument();

    const retry = screen.getByRole('button', { name: /try again/i });

    fireEvent.click(retry);

    // Retry called refetch(), which resolves with the second mocked response.
    expect(await screen.findByText('holiday')).toBeInTheDocument();
    expect(screen.queryByText('Could not load tags')).not.toBeInTheDocument();
  });
});
