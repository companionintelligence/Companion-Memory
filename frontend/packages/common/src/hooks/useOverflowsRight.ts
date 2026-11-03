import { useScrollOverflow } from './useScrollOverflow';

/**
 * Whether a sideways-scrolling row still has content past its right edge.
 *
 * A phone uses it to fade that edge, so a row of buttons or chips that runs off
 * the screen reads as "swipe for more" rather than as cut off. The right-edge
 * half of {@link useScrollOverflow}; see there for when it is re-measured.
 */
export function useOverflowsRight<T extends HTMLElement>(): [(element: T | null) => void, boolean] {
  const [ref, overflow] = useScrollOverflow<T>();

  return [ref, overflow.right];
}
