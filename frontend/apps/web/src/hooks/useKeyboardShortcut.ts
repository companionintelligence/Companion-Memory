import { useCallback, useEffect } from 'react';

interface Props {
  includeEditable?: boolean;
}

export function useKeyboardShortcut(
  key: string,
  callback: (e: KeyboardEvent) => void,
  { includeEditable = false }: Props = {},
) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isEditable =
        target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      if (e.key === key && (includeEditable || !isEditable)) {
        e.preventDefault();
        callback(e);
      }
    },
    [callback, key, includeEditable],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}
