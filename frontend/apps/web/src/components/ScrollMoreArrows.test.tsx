import { useScrollOverflow } from '@ci/common';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ScrollMoreArrows } from './ScrollMoreArrows';

function Strip() {
  const [ref, more] = useScrollOverflow<HTMLDivElement>();

  return (
    <ScrollMoreArrows more={more}>
      <div ref={ref} data-testid="strip">
        <button type="button">One</button>
        <button type="button">Two</button>
      </div>
    </ScrollMoreArrows>
  );
}

/** jsdom lays nothing out, so give the strip the sizes a browser would. */
function size(
  strip: HTMLElement,
  { clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number },
) {
  Object.defineProperty(strip, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: scrollWidth });
}

function scrollTo(strip: HTMLElement, scrollLeft: number) {
  strip.scrollLeft = scrollLeft;
  fireEvent.scroll(strip);
}

const shown = (side: 'left' | 'right') =>
  screen.getByTestId(`scroll-more-${side}`).hasAttribute('data-shown');

describe('ScrollMoreArrows', () => {
  it('points only the way there is more to see', () => {
    render(<Strip />);
    const strip = screen.getByTestId('strip');
    size(strip, { clientWidth: 300, scrollWidth: 800 });

    scrollTo(strip, 0);
    expect([shown('left'), shown('right')]).toEqual([false, true]);

    scrollTo(strip, 250);
    expect([shown('left'), shown('right')]).toEqual([true, true]);

    scrollTo(strip, 500);
    expect([shown('left'), shown('right')]).toEqual([true, false]);
  });

  it('shows nothing when the whole row fits', () => {
    render(<Strip />);
    const strip = screen.getByTestId('strip');
    size(strip, { clientWidth: 800, scrollWidth: 800 });

    scrollTo(strip, 0);
    expect([shown('left'), shown('right')]).toEqual([false, false]);
  });

  it('ignores the sub-pixel remainder a zoomed screen leaves at either end', () => {
    render(<Strip />);
    const strip = screen.getByTestId('strip');
    size(strip, { clientWidth: 300, scrollWidth: 800 });

    scrollTo(strip, 0.5);
    expect(shown('left')).toBe(false);

    scrollTo(strip, 499.5);
    expect(shown('right')).toBe(false);
  });

  it('re-measures when an item is added without the row itself scrolling', async () => {
    render(<Strip />);
    const strip = screen.getByTestId('strip');
    size(strip, { clientWidth: 800, scrollWidth: 800 });
    scrollTo(strip, 0);
    expect(shown('right')).toBe(false);

    size(strip, { clientWidth: 800, scrollWidth: 1200 });
    await act(async () => {
      strip.append(document.createElement('button'));
      // MutationObserver callbacks run as a microtask.
      await Promise.resolve();
    });

    expect(shown('right')).toBe(true);
  });

  it('keeps the arrows out of the way of taps and screen readers', () => {
    render(<Strip />);

    for (const side of ['left', 'right'] as const) {
      const arrow = screen.getByTestId(`scroll-more-${side}`);
      expect(arrow).toHaveAttribute('aria-hidden', 'true');
      expect(arrow).toHaveClass('pointer-events-none');
    }
  });
});
