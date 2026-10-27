import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ThreadGridItem,
  THREAD_FRAGMENT as GRID_THREAD_FRAGMENT,
} from '@/components/entities/grid/ThreadGridItem';
import {
  ThreadResult,
  THREAD_FRAGMENT as RESULT_THREAD_FRAGMENT,
} from '@/components/SearchBox/results/ThreadResult';
import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { THREAD_FRAGMENT, ThreadRow } from './ThreadRow';

const thread = (name: string | null) => ({
  __typename: 'ThreadType' as const,
  id: '01a17766-d5c7-712b-afc0-d237c326fcf5',
  name,
  description: null,
});

describe('untitled chat threads', () => {
  it('names an untitled thread in the explorer list instead of leaving the row blank', () => {
    renderWithProviders(<ThreadRow thread={makeFragmentData(thread(null), THREAD_FRAGMENT)} />);

    expect(screen.getByText('Untitled chat')).toBeInTheDocument();
  });

  it('treats a blank title as untitled and keeps a real one', () => {
    const { unmount } = renderWithProviders(
      <ThreadRow thread={makeFragmentData(thread('  '), THREAD_FRAGMENT)} />,
    );

    expect(screen.getByText('Untitled chat')).toBeInTheDocument();
    unmount();

    renderWithProviders(
      <ThreadRow thread={makeFragmentData(thread('Spring cafe plans'), THREAD_FRAGMENT)} />,
    );

    expect(screen.getByText('Spring cafe plans')).toBeInTheDocument();
    expect(screen.queryByText('Untitled chat')).not.toBeInTheDocument();
  });

  it('names it the same way in the gallery and in the header search', () => {
    renderWithProviders(
      <>
        <ThreadGridItem thread={makeFragmentData(thread(null), GRID_THREAD_FRAGMENT)} />
        <ThreadResult thread={makeFragmentData(thread(null), RESULT_THREAD_FRAGMENT)} />
      </>,
    );

    expect(screen.getAllByText('Untitled chat')).toHaveLength(2);
  });
});
