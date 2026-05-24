import { useLayoutEffect, useRef } from 'react';

export function usePreventOverscroll(isLocked: boolean = true) {
  const scrollPosition = useRef(0);

  useLayoutEffect(() => {
    if (isLocked) {
      scrollPosition.current = window.scrollY;

      const { style } = document.body;

      style.overflow = 'hidden';
      style.position = 'fixed';
      style.width = '100%';
      style.top = `-${scrollPosition.current}px`;

      return () => {
        style.overflow = '';
        style.position = '';
        style.width = '';
        style.top = '';

        window.scrollTo(0, scrollPosition.current);
      };
    }

    return undefined;
  }, [isLocked]);
}
