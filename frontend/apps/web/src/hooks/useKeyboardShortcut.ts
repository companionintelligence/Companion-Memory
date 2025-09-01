import { useEffect } from 'react';

interface UseKeyboardShortcutOptions {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;  
  shiftKey?: boolean;
  altKey?: boolean;
  preventDefault?: boolean;
  enabled?: boolean;
}

export function useKeyboardShortcut(
  callback: () => void,
  options: UseKeyboardShortcutOptions
) {
  const {
    key,
    ctrlKey = false,
    metaKey = false,
    shiftKey = false,
    altKey = false,
    preventDefault = true,
    enabled = true,
  } = options;

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the key matches
      if (event.key.toLowerCase() !== key.toLowerCase()) return;

      // Check modifier keys
      if (event.ctrlKey !== ctrlKey) return;
      if (event.metaKey !== metaKey) return;
      if (event.shiftKey !== shiftKey) return;
      if (event.altKey !== altKey) return;

      // Don't trigger if user is typing in an input/textarea
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      if (preventDefault) {
        event.preventDefault();
        event.stopPropagation();
      }

      callback();
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [callback, key, ctrlKey, metaKey, shiftKey, altKey, preventDefault, enabled]);
}

// Convenience hook for common shortcuts
export function useGlobalSearch(callback: () => void, enabled: boolean = true) {
  // Use Cmd+K on Mac, Ctrl+K on other platforms
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  
  useKeyboardShortcut(callback, {
    key: 'k',
    metaKey: isMac,
    ctrlKey: !isMac,
    enabled,
  });
}