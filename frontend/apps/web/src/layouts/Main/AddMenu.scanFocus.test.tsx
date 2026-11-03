/**
 * "+ > Scan" on a phone has to land in the code field, ready for a scanner
 * (which types the digits and presses Enter). The real ScanBarcodeModal is
 * rendered here, inside the real AddMenu, so the menu's close and the sheet's
 * focus trap race exactly as they do in the app.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { AddMenu } from './AddMenu';

vi.mock('@/components/modals/ThingModal', () => ({ ThingModal: () => null }));
vi.mock('@/components/modals/CaptureModal', () => ({ CaptureModal: () => null }));
vi.mock('@/components/modals/UploadModal', () => ({ UploadModal: () => null }));
vi.mock('@/components/modals/AddItemModal', () => ({
  AddEventModal: () => null,
  AddPersonModal: () => null,
  AddPlaceModal: () => null,
}));
vi.mock('@/components/modals/AddItemModal/AddConceptModal.tsx', () => ({ AddConceptModal: () => null }));

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>();

  return {
    ...actual,
    useUploadFile: () => [{}, { upload: vi.fn(), reset: vi.fn() }],
    useTriggerHbpe: () => [{}, { trigger: vi.fn() }],
  };
});

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : query.includes('landscape') ? !mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

async function openScan() {
  renderWithProviders(<AddMenu />);

  const trigger = screen.getByRole('button', { name: /NAV_ADD|add/i });

  // Radix's DropdownMenuTrigger opens on pointerdown, not click.
  fireEvent.pointerDown(trigger, { button: 0 });
  await screen.findByRole('menu');

  fireEvent.click(screen.getByRole('menuitem', { name: /scan/i }));

  return screen.findByRole('textbox', { name: 'Code value' });
}

/** Let the closing menu's deferred focus restore (a setTimeout 0) and any rAF run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('+ > Scan focus', () => {
  afterEach(() => {
    setViewport(false);
    document.body.style.pointerEvents = '';
  });

  it('focuses the code field on a phone, after the menu has finished closing', async () => {
    setViewport(true);

    const input = await openScan();

    await settle();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('focuses the code field on desktop too', async () => {
    const input = await openScan();

    await settle();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});
