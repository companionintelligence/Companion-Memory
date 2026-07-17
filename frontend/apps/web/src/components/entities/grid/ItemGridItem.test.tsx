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
    expect(screen.getByText('Item')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders an image (prefixed with /static) when the item has a file', () => {
    renderWithProviders(
      <ItemGridItem item={makeItem({ file: { __typename: 'FileType', id: 'f1', sourceUrl: '/u/d.jpg' } })} />,
    );

    expect(screen.getByRole('img')).toHaveAttribute('src', '/static/u/d.jpg');
  });

  it('fires onClick and the inventory-select callback', () => {
    const onClick = vi.fn();
    const onSelectInventoryItem = vi.fn();
    renderWithProviders(
      <ItemGridItem item={makeItem()} onClick={onClick} onSelectInventoryItem={onSelectInventoryItem} />,
    );

    fireEvent.click(screen.getByText('Drill'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSelectInventoryItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1', name: 'Drill' }));
  });
});
