/**
 * Mouse buttons 3 and 4 are the browser's own Back and Forward (the thumb buttons
 * on most mice). Pressing one over the page is still a pointer-down outside the
 * drawer, so Radix dismissed the sheet on it — and then the browser ran the Back
 * it was asked for. With `useBackClosesSheet` that was two history pops for one
 * press: the sheet's own entry, then the page's filter. Skip the dismissal for those
 * buttons and let the navigation close the sheet, same as the browser's Back button.
 */
export function ignoreHistoryMouseButtons(event: {
  detail: { originalEvent: Event };
  preventDefault: () => void;
}): void {
  const button = (event.detail.originalEvent as Partial<MouseEvent>).button;

  if (button === 3 || button === 4) {
    event.preventDefault();
  }
}
