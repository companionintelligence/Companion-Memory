import type L from 'leaflet';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isolateFromMap, registerMap } from './mapIsolation';

/*
 * The contract Radix's dismissable layer needs: a press on an isolated
 * control still bubbles up to `document` (mousedown, touchstart, click), while
 * the map's own reactions (drag, click, double-click zoom) are kept off some
 * other way. A right-click bubbles too, for the cards' own context menus.
 */

function fakeMap(container: HTMLElement, { draggingOn = true } = {}) {
  let enabled = draggingOn;
  const dragging = {
    enabled: () => enabled,
    enable: vi.fn(() => {
      enabled = true;
    }),
    disable: vi.fn(() => {
      enabled = false;
    }),
  };

  return { map: { getContainer: () => container, dragging } as unknown as L.Map, dragging };
}

function mount({ draggingOn = true } = {}) {
  const container = document.createElement('div');

  container.className = 'leaflet-container';
  const control = document.createElement('div');
  const inner = document.createElement('p');

  control.appendChild(inner);
  container.appendChild(control);
  document.body.appendChild(container);

  const { map, dragging } = fakeMap(container, { draggingOn });

  registerMap(map);
  isolateFromMap(control);

  return { container, control, inner, dragging };
}

function reaches(type: string, target: Element, init: EventInit = {}) {
  const seen = vi.fn();

  document.addEventListener(type, seen, { once: true });
  target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
  document.removeEventListener(type, seen);

  return seen.mock.calls.length > 0;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isolateFromMap', () => {
  it('lets mousedown, touchstart and click bubble up to the document', () => {
    const { inner } = mount();

    expect(reaches('mousedown', inner)).toBe(true);
    expect(reaches('touchstart', inner)).toBe(true);
    expect(reaches('click', inner)).toBe(true);
  });

  it('holds map dragging off for the length of a press that starts on the control', () => {
    const { inner, dragging } = mount();

    inner.dispatchEvent(new Event('mousedown', { bubbles: true }));

    expect(dragging.disable).toHaveBeenCalledTimes(1);
    expect(dragging.enable).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('mouseup', { bubbles: true }));

    expect(dragging.enable).toHaveBeenCalledTimes(1);

    // The release listeners are one-shot: a later mouseup elsewhere does nothing.
    document.dispatchEvent(new Event('mouseup', { bubbles: true }));

    expect(dragging.enable).toHaveBeenCalledTimes(1);
  });

  it('gives dragging back on touchend after a touch press', () => {
    const { inner, dragging } = mount();

    inner.dispatchEvent(new Event('touchstart', { bubbles: true }));
    // The compatibility mousedown that follows a touch press finds dragging
    // already off and leaves it alone — no second hold, no double release.
    inner.dispatchEvent(new Event('mousedown', { bubbles: true }));

    expect(dragging.disable).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('touchend', { bubbles: true }));

    expect(dragging.enable).toHaveBeenCalledTimes(1);
  });

  it('leaves dragging alone when the map has it off already', () => {
    const { inner, dragging } = mount({ draggingOn: false });

    inner.dispatchEvent(new Event('mousedown', { bubbles: true }));
    document.dispatchEvent(new Event('mouseup', { bubbles: true }));

    expect(dragging.disable).not.toHaveBeenCalled();
    expect(dragging.enable).not.toHaveBeenCalled();
  });

  it('still bubbles a press when no map is registered for the container', () => {
    const container = document.createElement('div');
    const control = document.createElement('div');

    container.appendChild(control);
    document.body.appendChild(container);
    isolateFromMap(control);

    expect(reaches('mousedown', control)).toBe(true);
  });

  it('keeps double-click from the map, which the dismissable layer does not watch', () => {
    const { inner } = mount();

    expect(reaches('dblclick', inner)).toBe(false);
  });

  it('lets a right-click bubble, so React’s root listener can open a card’s context menu', () => {
    const { inner } = mount();

    expect(reaches('contextmenu', inner)).toBe(true);
  });

  it("sets the click flag Leaflet's Map reads instead of stopping the click", () => {
    const { control } = mount();

    expect((control as HTMLElement & { _leaflet_disable_click?: boolean })._leaflet_disable_click).toBe(true);
  });
});
