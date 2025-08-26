import { type RefObject, type UIEvent, useCallback, useEffect, useRef } from 'react';

interface Opts {
  threshold?: number;
}

export function useConditionalAutoscroll<T extends HTMLElement>(
  ref: RefObject<T | null>,
  { threshold = 50 }: Opts,
) {
  const nearBottomRef = useRef(true);
  const isAutoRef = useRef(false);
  const targetTopRef = useRef(0);

  const onScroll = useCallback(
    (e: UIEvent<T>) => {
      const el = e.currentTarget as HTMLElement;

      if (isAutoRef.current && Math.abs(el.scrollTop - targetTopRef.current) <= 1) {
        isAutoRef.current = false;
      }

      nearBottomRef.current = getDistanceToBottom(el) <= threshold;

      if (isAutoRef.current) {
        return;
      }
    },
    [threshold],
  );

  const maybeAutoScroll = useCallback(
    (force: boolean = false) => {
      const el = ref.current;

      if (!el) {
        return;
      }

      if (!nearBottomRef.current && !force) {
        return;
      }

      isAutoRef.current = true;
      targetTopRef.current = Math.max(0, el.scrollHeight - el.clientHeight);

      requestAnimationFrame(() => {
        el.scrollTo({
          top: force ? el.scrollHeight : targetTopRef.current,
          behavior: 'smooth',
        });
      });
    },
    [ref],
  );

  useEffect(() => {
    const el = ref.current;

    if (!el) {
      return;
    }

    const cancel = () => (isAutoRef.current = false);

    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('touchstart', cancel, { passive: true });

    return () => {
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('touchstart', cancel);
    };
  }, [ref]);

  return {
    onScroll,
    maybeAutoScroll,
  };
}

function getDistanceToBottom(el: HTMLElement) {
  return el.scrollHeight - (el.scrollTop + el.clientHeight);
}
