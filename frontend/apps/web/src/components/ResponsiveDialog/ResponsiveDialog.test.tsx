import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ResponsiveDialog } from './ResponsiveDialog';

const originalMatchMedia = window.matchMedia;

function stubViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('ResponsiveDialog', () => {
  it('renders a centered dialog on desktop', () => {
    stubViewport(false);

    renderWithProviders(
      <ResponsiveDialog open onOpenChange={() => undefined}>
        <ResponsiveDialog.Content>
          <ResponsiveDialog.Title>Add Person</ResponsiveDialog.Title>
        </ResponsiveDialog.Content>
      </ResponsiveDialog>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Add Person')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  it('slides up as a bottom sheet on a phone', () => {
    stubViewport(true);

    renderWithProviders(
      <ResponsiveDialog open onOpenChange={() => undefined}>
        <ResponsiveDialog.Content>
          <ResponsiveDialog.Title>Add Person</ResponsiveDialog.Title>
        </ResponsiveDialog.Content>
      </ResponsiveDialog>,
    );

    const sheet = document.querySelector('[data-slot="sheet-content"]');

    expect(sheet).toBeInTheDocument();
    expect(sheet).toHaveClass('data-[state=open]:slide-in-from-bottom');
    expect(screen.getByText('Add Person')).toBeInTheDocument();
  });
});
