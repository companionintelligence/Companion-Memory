import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ACTION_FRAGMENT, ActionGridItem } from './ActionGridItem';

const makeAction = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'ActionType' as const,
      id: 'ac1',
      actionTitle: 'Book a flight',
      actionText: 'Find the **cheapest** option',
      ...overrides,
    },
    ACTION_FRAGMENT,
  );

describe('ActionGridItem', () => {
  it('renders the action title, markdown text and type label', () => {
    renderWithProviders(<ActionGridItem action={makeAction()} />);

    expect(screen.getByText('Book a flight')).toBeInTheDocument();
    expect(screen.getByText('cheapest').tagName).toBe('STRONG');
    expect(screen.getByText('Action')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<ActionGridItem action={makeAction()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Book a flight'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
