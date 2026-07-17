import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PLACE_FRAGMENT, PlaceGridItem } from './PlaceGridItem';

const makePlace = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'PlaceType' as const,
      id: 'pl1',
      name: 'Long Beach',
      description: 'A coastal city',
      properties: null,
      ...overrides,
    },
    PLACE_FRAGMENT,
  );

describe('PlaceGridItem', () => {
  it('renders the place name, description and type label', () => {
    renderWithProviders(<PlaceGridItem place={makePlace()} />);

    expect(screen.getByText('Long Beach')).toBeInTheDocument();
    expect(screen.getByText('A coastal city')).toBeInTheDocument();
    expect(screen.getByText('Place')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<PlaceGridItem place={makePlace()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Long Beach'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
