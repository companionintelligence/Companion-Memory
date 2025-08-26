import { useCallback, useState } from 'react';

type Opts = {
  open?: boolean;
};

type Value = [
  {
    isOpen: boolean;
  },
  {
    open: () => void;
    close: () => void;
    toggle: () => void;
  },
];

export function useModalControls(options?: Opts): Value {
  const resolvedOptions = options ?? ({} as Opts);
  const { open: initialOpen = false } = resolvedOptions;

  const [isOpen, setIsOpen] = useState(initialOpen);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  return [
    {
      isOpen,
    },
    {
      open,
      close,
      toggle,
    },
  ];
}
