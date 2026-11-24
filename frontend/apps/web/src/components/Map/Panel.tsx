import { type ReactNode, useCallback, useRef } from 'react';

import { ScrollArea, cn } from '@ci/shadcn';

import { useMapIsolation } from './mapIsolation';

interface Props {
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'left' | 'right';
  className?: string;
  children?: ReactNode;
}

const POSITION_CLASSES = {
  'top-left': 'top-0 left-0 h-fit w-fit',
  'top-right': 'top-0 right-0 h-fit w-fit',
  'bottom-left': 'bottom-0 left-0 h-fit w-fit',
  'bottom-right': 'bottom-0 right-0 h-fit w-fit',
  left: 'top-0 left-0 h-full w-1/4',
  right: 'top-0 right-0 h-full w-1/4',
};

export function Panel({ position = 'right', className, children }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isolate = useMapIsolation();

  const setPanelRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        panelRef.current = el;
        isolate(el);
      }
    },
    [isolate],
  );

  return (
    <div
      className={cn('z-400 cursor-default text-base', POSITION_CLASSES[position], className, 'absolute')}
      ref={setPanelRef}
    >
      <ScrollArea className="h-full w-full" collapseX>
        {children}
      </ScrollArea>
    </div>
  );
}
