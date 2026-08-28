import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ITEM_FRAGMENT, ItemGridItem } from './ItemGridItem';

const makeItem = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'ItemType' as const,
      id: 'i1',
      name: 'Drill',
      description: 'Cordless 18V',
      category: 'tools',
      brand: 'Makita',
      model: 'XPH',
      currentValue: null,
      currency: 'USD',
      quantity: 1,
      lifecycleState: 'ACTIVE' as const,
      identifiers: [],
      product: null,
      lastSeenAt: null,
      file: null,
      ...overrides,
    },
    ITEM_FRAGMENT,
  );

describe('ItemGridItem', () => {
  it('renders the item name, description and type label', () => {
    renderWithProviders(<ItemGridItem item={makeItem()} />);

    expect(screen.getByText('Drill')).toBeInTheDocument();
    expect(screen.getByText('Cordless 18V')).toBeInTheDocument();
    expect(screen.getByText('Thing')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders an image (prefixed with /static) when the item has a file', () => {
    renderWithProviders(
      <ItemGridItem item={makeItem({ file: { __typename: 'FileType', id: 'f1', sourceUrl: '/u/d.jpg' } })} />,
    );

    expect(screen.getByRole('img')).toHaveAttribute('src', '/static/u/d.jpg');
  });

  it('shows how many of the thing there are, and only when it is more than one', () => {
    // The count is the one fact a grid cannot show twice: two rows of "AA
    // battery" mean two ROWS, not two batteries.
    const { unmount } = renderWithProviders(<ItemGridItem item={makeItem()} />);

    expect(screen.queryByText(/^×/)).toBeNull();

    unmount();

    renderWithProviders(<ItemGridItem item={makeItem({ quantity: 3 })} />);

    expect(screen.getByText('×3')).toBeInTheDocument();
  });

  it('humanizes a non-active lifecycle state rather than shouting the raw enum', () => {
    renderWithProviders(<ItemGridItem item={makeItem({ lifecycleState: 'LENT_OUT' })} />);

    expect(screen.getByText('Lent out')).toBeInTheDocument();
    expect(screen.queryByText('LENT_OUT')).toBeNull();
  });

  it('says nothing about an active thing — that is the boring case', () => {
    renderWithProviders(<ItemGridItem item={makeItem()} />);

    expect(screen.queryByText('Active')).toBeNull();
  });

  it('fires onClick and the thing-select callback', () => {
    const onClick = vi.fn();
    const onSelectThing = vi.fn();
    renderWithProviders(<ItemGridItem item={makeItem()} onClick={onClick} onSelectThing={onSelectThing} />);

    fireEvent.click(screen.getByText('Drill'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSelectThing).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1', name: 'Drill' }));
  });
});
