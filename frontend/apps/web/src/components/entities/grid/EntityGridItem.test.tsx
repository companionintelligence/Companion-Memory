import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EntityGridItem } from './EntityGridItem';

describe('EntityGridItem', () => {
  it('renders children and fires onClick on the card', () => {
    const onClick = vi.fn();
    render(
      <EntityGridItem onClick={onClick}>
        <EntityGridItem.Header>
          <span>header</span>
        </EntityGridItem.Header>
        <EntityGridItem.Content>
          <span>content</span>
        </EntityGridItem.Content>
        <EntityGridItem.Footer>
          <span>footer</span>
        </EntityGridItem.Footer>
      </EntityGridItem>,
    );

    expect(screen.getByText('header')).toBeInTheDocument();
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getByText('footer')).toBeInTheDocument();

    fireEvent.click(screen.getByText('content'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  describe('Meta', () => {
    it('renders non-falsy items with separators between them', () => {
      render(
        <EntityGridItem.Meta>
          {[<span key="a">Jan 1</span>, null, <span key="b">Gmail</span>]}
        </EntityGridItem.Meta>,
      );

      expect(screen.getByText('Jan 1')).toBeInTheDocument();
      expect(screen.getByText('Gmail')).toBeInTheDocument();
      // One separator between the two surviving items.
      expect(screen.getAllByText('·')).toHaveLength(1);
    });

    it('renders nothing when all items are falsy', () => {
      const { container } = render(<EntityGridItem.Meta>{[null, false, undefined]}</EntityGridItem.Meta>);

      expect(container).toBeEmptyDOMElement();
    });
  });
});
