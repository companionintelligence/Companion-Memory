import { useEffect, useRef } from 'react';

import { useLocation } from 'react-router-dom';

import { usePowerRail } from '../PowerRailContext';
import { SecondaryNavigation } from '../SecondaryNavigation';

const EDGE_PX = 28;
const THRESHOLD_PX = 48;

// Standard tabbable-element set for a hand-rolled focus trap: links and
// buttons with an href/no disabled, controls, and anything holding an
// explicit non-negative tabindex.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Phone chrome around the glass Power Rail.
 *
 * Closed: a chevron in the top bar and a swipe right from the left edge.
 * Open: the same rail as desktop, glassed. Search lives in the top bar.
 */
export function MobileNavigation() {
  const { expanded, openOverlay, closeOverlay } = usePowerRail();
  const { pathname } = useLocation();
  const start = useRef<{ x: number; y: number; tracking: boolean } | null>(null);
  const scrimRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeOverlay();
  }, [pathname, closeOverlay]);

  // While the drawer is open: take the rest of the page out of the tab order
  // and off the a11y tree (genuinely, via `inert`, not just visually behind
  // the scrim), trap Tab/Shift+Tab inside the drawer, close on Escape, and
  // hand focus back to whatever opened it when it closes.
  //
  // The drawer itself (`#power-rail`) and this component's own scrim button
  // are siblings of the page content in the DOM (this component renders no
  // wrapper of its own), so the "page content" to inert is everything else
  // under the drawer's parent.
  useEffect(() => {
    if (!expanded) {
      return;
    }

    const nav = document.getElementById('power-rail');

    if (!nav) {
      return;
    }

    const scrim = scrimRef.current;
    const trigger = document.activeElement;
    const container = nav.parentElement;
    const inerted: HTMLElement[] = [];

    if (container) {
      for (const child of Array.from(container.children)) {
        if (!(child instanceof HTMLElement) || child === nav || child === scrim) {
          continue;
        }

        // Set the `inert` attribute itself, not the IDL property — the
        // property is what real browsers expose for reading it back, but the
        // attribute is the actual source of truth they reflect it from, and
        // it is what `inert` means literally: an HTML attribute.
        if (!child.hasAttribute('inert')) {
          child.setAttribute('inert', '');
          inerted.push(child);
        }
      }
    }

    const getFocusable = () => Array.from(nav.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    getFocusable()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeOverlay();

        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const items = getFocusable();

      if (items.length === 0) {
        event.preventDefault();

        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !nav.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !nav.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);

      for (const el of inerted) {
        el.removeAttribute('inert');
      }

      if (trigger instanceof HTMLElement) {
        trigger.focus();
      }
    };
  }, [expanded, closeOverlay]);

  useEffect(() => {
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];

      if (!touch) {
        return;
      }

      const fromEdge = touch.clientX <= EDGE_PX;
      const fromRail = expanded && touch.clientX <= 224;

      start.current = {
        x: touch.clientX,
        y: touch.clientY,
        tracking: expanded ? fromRail : fromEdge,
      };
    };

    const onEnd = (event: TouchEvent) => {
      const origin = start.current;
      start.current = null;

      if (!origin?.tracking) {
        return;
      }

      const touch = event.changedTouches[0];

      if (!touch) {
        return;
      }

      const dx = touch.clientX - origin.x;
      const dy = touch.clientY - origin.y;

      if (Math.abs(dy) > Math.abs(dx)) {
        return;
      }

      if (!expanded && dx >= THRESHOLD_PX) {
        openOverlay();
      } else if (expanded && dx <= -THRESHOLD_PX) {
        closeOverlay();
      }
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, [expanded, openOverlay, closeOverlay]);

  return (
    <>
      {expanded && (
        <button
          ref={scrimRef}
          type="button"
          aria-label="Dismiss menu"
          className="fixed inset-0 z-30 bg-black/25"
          onClick={closeOverlay}
        />
      )}

      <SecondaryNavigation />
    </>
  );
}
