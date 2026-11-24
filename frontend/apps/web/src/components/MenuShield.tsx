import { useEffect, useRef, useState } from 'react';

import { createPortal } from 'react-dom';

/**
 * How long the shield stays after its menu closes, waiting for the click of the
 * tap that closed it. A tap's click follows its pointerup within a few tens of
 * milliseconds; this is a ceiling for the case where no click ever comes (the
 * menu closed some other way), not a delay anyone sees.
 */
export const MENU_SHIELD_LINGER_MS = 300;

/**
 * A transparent sheet over the whole page while a menu is open on a phone, so
 * a tap outside the menu lands HERE, closes the menu, and reaches nothing else.
 *
 * Radix's modal menus try to do this by turning pointer events off on `body`,
 * but that is undone by any element that turns them back on for itself — and
 * several do: Leaflet gives every map pin `pointer-events: auto`, and so do the
 * map's top bar buttons, its status card and the playback bar. A tap on one of
 * those while a menu was open both closed the menu AND pressed the thing.
 *
 * The sheet sits in a portal at the end of `body`, placed in the tree BEFORE
 * the menu's content so the content's own portal lands after it and draws on
 * top at the same z-index. It lies outside the menu's dismissable layer, so
 * the tap on it is an outside press and closes the menu as before. Hidden on
 * desktop (`max-device:` only), where the menus stay non-modal and a click
 * outside is meant to go through. Explicitly `pointer-events-auto` because
 * the modal layer's body rule would otherwise switch the sheet off too.
 *
 * ## It outlives the menu by one click
 *
 * A Popover closes on the PRESS (pointerdown); only DropdownMenu waits for the
 * click. So for the How / When / Who pickers the menu — and a sheet that
 * followed `open` exactly — was gone before the same tap's `click` fired, and
 * that click hit whatever lay under the finger: the top row of the list, a
 * pin. Measured on the phone over the WebView debug port, 2026-10-08. The sheet
 * therefore stays until the next click anywhere (which it catches) or
 * {@link MENU_SHIELD_LINGER_MS}, whichever comes first.
 */
export function MenuShield({ open }: { open: boolean }) {
  // Lingering after `open` has gone false — see the note above. `wasOpen` is
  // read during render so the render that closes the menu still shows the
  // sheet: an unmount-and-remount around the effect would leave a gap in the
  // hit test, and hand the test (and a fast click) a detached node.
  const [lingering, setLingering] = useState(false);
  const wasOpen = useRef(open);
  const closingNow = wasOpen.current && !open;

  useEffect(() => {
    const closing = wasOpen.current && !open;

    wasOpen.current = open;

    if (open) {
      setLingering(false);

      return;
    }

    if (!closing) {
      return;
    }

    setLingering(true);

    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', done, true);
      setLingering(false);
    };

    document.addEventListener('click', done, true);
    timer = window.setTimeout(done, MENU_SHIELD_LINGER_MS);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', done, true);
    };
  }, [open]);

  if ((!open && !lingering && !closingNow) || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      aria-hidden
      data-testid="menu-shield"
      className="pointer-events-auto fixed inset-0 z-50 hidden max-device:block"
    />,
    document.body,
  );
}
