import { useEffect, useRef } from 'react';

import {
  SCHEDULE_DROP_AXIS_ATTR,
  axisOfDropElement,
  dropElementAt,
  ratioOnAxis,
  subscribeSchedulePointerEnd,
  subscribeSchedulePointerMove,
  type ScheduleDropAxis,
} from '@/lib/schedulePointerDrag';

interface Options {
  axis: ScheduleDropAxis;
  onDropCandidate?: (candidateId: string, ratio: number) => void;
  onMoveEvent?: (eventId: string, ratio: number, grabOffsetMs: number) => void;
  onHoverPct: (pct: number | null) => void;
}

/**
 * Marks a day lane as a pointer-drop target and drives the same hover line
 * HTML5 dragover already shows.
 */
export function useScheduleDropTarget({ axis, onDropCandidate, onMoveEvent, onHoverPct }: Options) {
  const ref = useRef<HTMLDivElement>(null);
  const accepts = Boolean(onDropCandidate ?? onMoveEvent);

  useEffect(() => {
    if (!accepts) {
      return;
    }

    const hover = (x: number, y: number) => {
      const el = ref.current;

      if (!el || dropElementAt(x, y) !== el) {
        onHoverPct(null);
        return;
      }

      onHoverPct(Math.max(0, Math.min(1, ratioOnAxis(el, axis, x, y))) * 100);
    };

    const unsubMove = subscribeSchedulePointerMove((drag) => {
      if (!drag) {
        onHoverPct(null);
        return;
      }

      hover(drag.x, drag.y);
    });

    const unsubEnd = subscribeSchedulePointerEnd((drag) => {
      const el = ref.current;
      onHoverPct(null);

      if (!el || dropElementAt(drag.x, drag.y) !== el) {
        return;
      }

      const dropAxis = axisOfDropElement(el) ?? axis;
      const ratio = ratioOnAxis(el, dropAxis, drag.x, drag.y);

      if (drag.payload.kind === 'candidate') {
        onDropCandidate?.(drag.payload.id, ratio);
        return;
      }

      onMoveEvent?.(drag.payload.id, ratio, drag.payload.grabOffsetMs);
    });

    return () => {
      unsubMove();
      unsubEnd();
    };
  }, [accepts, axis, onDropCandidate, onHoverPct, onMoveEvent]);

  return {
    dropRef: ref,
    dropAxis: accepts ? ({ [SCHEDULE_DROP_AXIS_ATTR]: axis } as const) : undefined,
  };
}
