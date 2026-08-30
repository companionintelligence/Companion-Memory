import { useCallback, useRef } from 'react';

import {
  CANCEL_PX,
  HOLD_MS,
  cancelSchedulePointerDrag,
  endSchedulePointerDrag,
  getSchedulePointerDrag,
  moveSchedulePointerDrag,
  startSchedulePointerDrag,
} from '@/lib/schedulePointerDrag';

type Gesture = {
  pointerId: number;
  startX: number;
  startY: number;
  timer: number | null;
  armed: boolean;
};

/**
 * Drag a Possibilities card on touch/pen. Mouse keeps HTML5.
 *
 * The six-dot handle starts immediately so a grab-and-move is a drag, not a
 * cancelled hold. The rest of the card still waits {@link HOLD_MS} so a flick
 * can scroll the list.
 */
export function useCandidatePointerDrag(task: { id: string; title: string }, enabled: boolean) {
  const gesture = useRef<Gesture | null>(null);

  const attachFollow = useCallback((target: HTMLElement, pointerId: number) => {
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }

      const current = gesture.current;

      if (!current) {
        return;
      }

      if (!current.armed) {
        if (Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY) > CANCEL_PX) {
          if (current.timer != null) {
            window.clearTimeout(current.timer);
          }

          gesture.current = null;
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        }

        return;
      }

      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }

      moveSchedulePointerDrag(moveEvent.clientX, moveEvent.clientY);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) {
        return;
      }

      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);

      const current = gesture.current;
      gesture.current = null;

      if (!current) {
        return;
      }

      if (current.timer != null) {
        window.clearTimeout(current.timer);
      }

      if (!current.armed) {
        return;
      }

      target.releasePointerCapture?.(pointerId);

      if (upEvent.type === 'pointercancel') {
        cancelSchedulePointerDrag();

        return;
      }

      endSchedulePointerDrag(upEvent.clientX, upEvent.clientY);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }

      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
      }

      if (event.button !== 0) {
        return;
      }

      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;

      const timer = window.setTimeout(() => {
        const current = gesture.current;

        if (!current || current.pointerId !== pointerId) {
          return;
        }

        current.armed = true;
        target.setPointerCapture?.(pointerId);
        startSchedulePointerDrag({ kind: 'candidate', id: task.id, title: task.title }, startX, startY);
      }, HOLD_MS);

      gesture.current = { pointerId, startX, startY, timer, armed: false };
      attachFollow(target, pointerId);
    },
    [attachFollow, enabled, task.id, task.title],
  );

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!enabled) {
        return;
      }

      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') {
        return;
      }

      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;

      target.setPointerCapture?.(pointerId);
      gesture.current = { pointerId, startX, startY, timer: null, armed: true };
      startSchedulePointerDrag({ kind: 'candidate', id: task.id, title: task.title }, startX, startY);
      attachFollow(target, pointerId);
    },
    [attachFollow, enabled, task.id, task.title],
  );

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (enabled || getSchedulePointerDrag()) {
        event.preventDefault();
      }
    },
    [enabled],
  );

  return { onPointerDown, onHandlePointerDown, onContextMenu };
}
