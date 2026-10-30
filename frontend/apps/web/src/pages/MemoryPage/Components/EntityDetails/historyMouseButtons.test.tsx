import { Sheet } from '@ci/shadcn';
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ignoreHistoryMouseButtons } from './historyMouseButtons';

async function renderOpenSheet() {
  const onOpenChange = vi.fn();

  render(
    <Sheet open onOpenChange={onOpenChange}>
      <Sheet.Content onPointerDownOutside={ignoreHistoryMouseButtons} aria-describedby={undefined}>
        <Sheet.Title>Drawer</Sheet.Title>
      </Sheet.Content>
    </Sheet>,
  );

  // Radix attaches its document pointerdown listener on the next tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  return onOpenChange;
}

// Radix 1.1.19 defers a primary-button pointerdown outside until the matching
// click (so a drag that starts outside does not dismiss); any other button
// dismisses on the pointerdown itself. That is exactly how one press of a mouse's
// Back button got to close the sheet before the browser ran the Back.
function pointerDownOutside(button: number) {
  const overlay = document.querySelector('[data-slot=sheet-overlay]') as HTMLElement;

  act(() => {
    fireEvent.pointerDown(overlay, { button, pointerType: 'mouse', bubbles: true });

    if (button === 0) {
      fireEvent.click(overlay, { button, bubbles: true });
    }
  });
}

describe('ignoreHistoryMouseButtons', () => {
  it('still dismisses the sheet on an ordinary click outside', async () => {
    const onOpenChange = await renderOpenSheet();

    pointerDownOutside(0);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    [3, 'Back'],
    [4, 'Forward'],
  ])('leaves the sheet open on mouse button %i (%s) so only the navigation closes it', async (button) => {
    const onOpenChange = await renderOpenSheet();

    pointerDownOutside(button);

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
