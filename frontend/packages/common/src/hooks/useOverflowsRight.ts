import { useCallback, useEffect, useState } from 'react';

/**
 * Whether a sideways-scrolling row still has content past its right edge.
 *
 * A phone uses it to fade that edge, so a row of buttons or chips that runs off
 * the screen reads as "swipe for more" rather than as cut off. It is re-measured
 * whenever the row scrolls or resizes, and stays false where nothing is hidden
 * (a wide screen, or a row scrolled to its end).
 *
 * Returns a callback ref rather than taking a ref object, so a row that mounts
 * after the hook first runs (one rendered only on a phone) is still measured.
 */
export function useOverflowsRight<T extends HTMLElement>(): [(element: T | null) => void, boolean] {
  const [row, setRow] = useState<T | null>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    if (!row) {
      setOverflows(false);

      return;
    }

    const measure = () => setOverflows(row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);

    measure();
    row.addEventListener('scroll', measure, { passive: true });
    observer?.observe(row);

    return () => {
      row.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [row]);

  const ref = useCallback((element: T | null) => setRow(element), []);

  return [ref, overflows];
}
