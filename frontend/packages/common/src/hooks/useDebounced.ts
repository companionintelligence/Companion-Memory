import { useEffect, useState } from 'react';

/**
 * `value` as it was `delayMs` ago, once it has held still that long: what a
 * query should see of a search box, so the server is asked after the typing
 * pauses and not on every keystroke. The first render returns `value` as is.
 */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);

    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
