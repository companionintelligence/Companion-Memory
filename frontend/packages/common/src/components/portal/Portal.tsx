import { type ReactNode, type ForwardedRef, forwardRef, useEffect, useReducer } from 'react';
import { createPortal } from 'react-dom';

interface PortalProps {
  id: string;
  className?: string;
}

function Portal({ id, className }: PortalProps, forwardedRef: ForwardedRef<HTMLDivElement>) {
  return <div id={id} ref={forwardedRef} className={className} />;
}

interface SlotProps {
  id: string;
  children: ReactNode;
}

function Slot({ id, children }: SlotProps) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const elem = document.getElementById(id);

  // The lookup above runs during render, so it can be stale by commit time: the
  // target may not be in the DOM yet, or may have been remounted in the same
  // commit (e.g. a target inside a keyed subtree, like SearchBox's toolsSlot).
  // Re-check after commit and re-render once to re-portal into the live node.
  useEffect(() => {
    if (elem !== document.getElementById(id)) {
      rerender();
    }
  });

  if (!elem) {
    return null;
  }

  return createPortal(children, elem);
}

const PortalForwarded = forwardRef(Portal);

type PortalComponent = typeof PortalForwarded & {
  Slot: typeof Slot;
};

const AugmentedPortal = PortalForwarded as PortalComponent;

AugmentedPortal.Slot = Slot;

export { AugmentedPortal as Portal };
