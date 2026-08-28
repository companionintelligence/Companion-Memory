import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import {
  getSchedulePointerDrag,
  subscribeSchedulePointerDrag,
} from '@/lib/schedulePointerDrag';

function subscribe(onStoreChange: () => void) {
  return subscribeSchedulePointerDrag(onStoreChange);
}

/**
 * Follows a touch drag so the card is still visible once the finger leaves
 * Possibilities and is over the calendar.
 */
export function ScheduleDragGhost() {
  const drag = useSyncExternalStore(subscribe, getSchedulePointerDrag, () => null);

  if (!drag || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-[80] max-w-[14rem] rounded-lg border border-primary/40 bg-background px-2.5 py-2 text-[13px] font-medium text-foreground shadow-lg"
      style={{
        left: drag.x,
        top: drag.y,
        transform: 'translate(-50%, calc(-100% - 12px))',
      }}
    >
      {drag.payload.title}
    </div>,
    document.body,
  );
}
