import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { THREAD_FRAGMENT, ThreadGridItem } from './ThreadGridItem';

const makeThread = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'ThreadType' as const,
      id: 'th1',
      name: 'Trip planning',
      description: 'Notes from the chat',
      ...overrides,
    },
    THREAD_FRAGMENT,
  );

describe('ThreadGridItem', () => {
  it('renders the thread name, description and type label', () => {
    renderWithProviders(<ThreadGridItem thread={makeThread()} />);

    expect(screen.getByText('Trip planning')).toBeInTheDocument();
    expect(screen.getByText('Notes from the chat')).toBeInTheDocument();
    expect(screen.getByText('Thread')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<ThreadGridItem thread={makeThread()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Trip planning'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
