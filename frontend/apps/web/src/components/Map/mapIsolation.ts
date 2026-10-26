import { useCallback } from 'react';

import L from 'leaflet';

/*
 * Controls that float over the map — the status card, Search this area, the
 * trace toggle, the playback bar, the side panel — must not pan or zoom the
 * map under them. `L.DomEvent.disableClickPropagation` is the usual tool, but
 * it calls stopPropagation on mousedown and touchstart, and Radix's
 * dismissable layer (under every Popover / DropdownMenu / Select) watches
 * exactly those events at the document: an outside press it sees in the
 * capture phase but never again in the bubble phase counts as "handled by
 * something else", and the dismiss it had deferred to the click is cancelled.
 * So with a filter menu open, tapping the "No located memories match these
 * filters" card closed nothing, on a phone and on desktop alike.
 *
 * `isolateFromMap` keeps each thing Leaflet starts from a press here off
 * without touching those two events:
 * - map `click` events: the `_leaflet_disable_click` flag, which
 *   Map._isClickDisabled reads on every click by walking up from the target —
 *   the half of disableClickPropagation that never touched propagation.
 * - dragging: the container's own mousedown / touchstart listener has no
 *   opt-out, so dragging is switched off for the length of a press that
 *   starts here. Removing that listener while the event is still on its way
 *   up keeps it from running for this very press.
 * - double-click zoom and wheel zoom: propagation stopped, as before. The
 *   dismissable layer does not watch dblclick or wheel.
 * - the context menu: left to bubble. React handles every event at the root,
 *   above the map, so stopping it here left the right-click menu on the side
 *   panel's cards dead. Letting it through costs nothing on the map: Leaflet
 *   only reacts to a contextmenu when the map or a layer under the pointer
 *   listens for one, and no map here listens on the map itself (a marker's
 *   listener is on its own icon, which these controls never contain).
 * A pinch that starts on the control still zooms (touchZoom wants two
 * fingers on the container), as it did before.
 */

const mapsByContainer = new WeakMap<HTMLElement, L.Map>();

/** `<Map>` calls this once its Leaflet map exists, so a control can find the map through the DOM. */
export function registerMap(map: L.Map): void {
  mapsByContainer.set(map.getContainer(), map);
}

function mapUnder(el: HTMLElement): L.Map | undefined {
  const container = el.closest<HTMLElement>('.leaflet-container');

  return container ? mapsByContainer.get(container) : undefined;
}

const RELEASE_EVENTS = ['mouseup', 'touchend', 'touchcancel'] as const;

/** Keep a press, click, double-click or wheel on `el` from reaching the map's own handlers. */
export function isolateFromMap(el: HTMLElement): void {
  (el as HTMLElement & { _leaflet_disable_click?: boolean })._leaflet_disable_click = true;
  L.DomEvent.on(el, 'dblclick', L.DomEvent.stopPropagation);
  L.DomEvent.disableScrollPropagation(el);

  const press = () => {
    // Looked up per press, not once: the map registers itself in an effect,
    // after the ref callback that set this listener up.
    const dragging = mapUnder(el)?.dragging;

    // Off already — the Map's draggingEnabled={false}, or this is the
    // compatibility mousedown that follows a touch press — so there is
    // nothing to hold and nothing to give back.
    if (!dragging?.enabled()) {
      return;
    }

    dragging.disable();

    const release = () => {
      RELEASE_EVENTS.forEach((type) => document.removeEventListener(type, release));
      dragging.enable();
    };

    RELEASE_EVENTS.forEach((type) => document.addEventListener(type, release));
  };

  el.addEventListener('mousedown', press);
  el.addEventListener('touchstart', press, { passive: true });
}

/** A ref callback that applies {@link isolateFromMap} to the element it is given. */
export function useMapIsolation(): (el: HTMLElement | null) => void {
  return useCallback((el: HTMLElement | null) => {
    if (el) {
      isolateFromMap(el);
    }
  }, []);
}
