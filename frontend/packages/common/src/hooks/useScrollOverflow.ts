import { useCallback, useEffect, useState } from 'react';

/** Whether a sideways-scrolling row has content hidden past each edge. */
export interface ScrollOverflow {
  left: boolean;
  right: boolean;
}

const NONE: ScrollOverflow = { left: false, right: false };

/**
 * Which edges of a sideways-scrolling row still hide content.
 *
 * It drives the "more this way" hints on a row of chips or buttons that runs
 * off the screen, so the row reads as "swipe for more" rather than as cut off.
 * Re-measured whenever the row scrolls or resizes, and whenever an item in it
 * is added, removed or resized — a new filter chip widens the content without
 * changing the row's own size. Both stay false where
 * nothing is hidden (a wide screen, or a row that wraps instead of scrolling).
 * The 1 px slack absorbs the fractional scroll positions a zoomed or
 * high-density screen reports at either end.
 *
 * Returns a callback ref rather than taking a ref object, so a row that mounts
 * after the hook first runs (one rendered only on a phone) is still measured.
 */
export function useScrollOverflow<T extends HTMLElement>(): [(element: T | null) => void, ScrollOverflow] {
  const [row, setRow] = useState<T | null>(null);
  const [overflow, setOverflow] = useState<ScrollOverflow>(NONE);

  useEffect(() => {
    if (!row) {
      setOverflow(NONE);

      return;
    }

    const measure = () => {
      const left = row.scrollLeft > 1;
      const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;

      // Same object back when nothing changed, so scrolling through the middle
      // of a row does not re-render its owner on every scroll event.
      setOverflow((previous) =>
        previous.left === left && previous.right === right ? previous : { left, right },
      );
    };

    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    // The row and its direct children: a strip that wraps its items in one
    // `w-max` element grows through that child, a row of chips through the
    // chips. Re-observed on every add or remove so a new chip is watched too.
    const observeItems = () => {
      if (!resizes) {
        return;
      }

      resizes.disconnect();
      resizes.observe(row);

      for (const child of Array.from(row.children)) {
        resizes.observe(child);
      }
    };

    const additions =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observeItems();
            measure();
          });

    observeItems();
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    additions?.observe(row, { childList: true });

    return () => {
      row.removeEventListener('scroll', measure);
      resizes?.disconnect();
      additions?.disconnect();
    };
  }, [row]);

  const ref = useCallback((element: T | null) => setRow(element), []);

  return [ref, overflow];
}
