import type { ComponentProps } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EntityMedia } from './media';
import { MediaLightbox } from './MediaLightbox';

function photo(n: number): EntityMedia {
  return {
    entityId: `entity-${n}`,
    kind: 'image',
    contentType: 'image/jpeg',
    thumbUrl: `https://cdn.example.com/${n}-thumb.jpg`,
    fullUrl: `https://cdn.example.com/${n}.jpg`,
    title: `Photo ${n}`,
  };
}

const ENTRIES = [photo(1), photo(2), photo(3)];

function renderLightbox(overrides: Partial<ComponentProps<typeof MediaLightbox>> = {}) {
  const props = {
    entries: ENTRIES,
    index: 1,
    onClose: vi.fn(),
    onIndexChange: vi.fn(),
    ...overrides,
  };

  render(<MediaLightbox {...props} />);

  return props;
}

/** The bar holding the counter, Open original / Download and ✕. */
function topBar(): HTMLElement {
  return screen.getByText('2 / 3').parentElement as HTMLElement;
}

/**
 * QA MEM-07 (iOS, bundled build): the lightbox is a full-bleed `fixed inset-0`
 * overlay, and its top bar was padded with `p-3` alone. On a phone the status bar
 * / Dynamic Island sits on top of the page and swallows every touch inside it, so
 * the counter, "Open original" and ✕ sat under it and could not be tapped — only
 * the backdrop closed the viewer.
 *
 * jsdom loads no CSS, so this pins the classes that carry the fix: the app's own
 * `--safe-area-*` tokens (`html.ci-native` pins them to the notch / indicator
 * height, because WKWebView can report `env()` as 0) behind a `max()` that keeps
 * the old 0.75rem / 1rem wherever they are 0 — desktop and the web.
 */
describe('MediaLightbox safe areas', () => {
  it('pads the top bar below the status bar / Dynamic Island', () => {
    renderLightbox();

    expect(topBar()).toHaveClass('pt-[max(0.75rem,var(--safe-area-top))]');
  });

  it('keeps the old padding on the other sides of the top bar, so desktop is unchanged', () => {
    renderLightbox();

    // `p-3` still sets all four sides; only the top is raised, by `max()`, which
    // resolves to the same 0.75rem wherever the safe-area token is 0.
    expect(topBar()).toHaveClass('p-3');
  });

  it('keeps the caption above the home indicator', () => {
    renderLightbox();

    expect(screen.getByText('Photo 2')).toHaveClass('pb-[max(1rem,var(--safe-area-bottom))]');
  });

  it('insets the whole overlay from the sensor housing in landscape', () => {
    renderLightbox();

    // On the container, not on one child: the counter, the buttons and the
    // Previous / Next chevrons all sit at the screen's left and right edges.
    expect(screen.getByRole('dialog')).toHaveClass(
      'pl-[env(safe-area-inset-left,0px)]',
      'pr-[env(safe-area-inset-right,0px)]',
    );
  });
});

describe('MediaLightbox controls', () => {
  it('closes from the ✕ button', () => {
    const { onClose } = renderLightbox();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the backdrop, but not from the bar or the media', () => {
    const { onClose } = renderLightbox();

    fireEvent.click(topBar());
    fireEvent.click(screen.getByAltText('Photo 2'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('steps between entries with Previous and Next', () => {
    const { onIndexChange } = renderLightbox();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onIndexChange).toHaveBeenLastCalledWith(2);

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onIndexChange).toHaveBeenLastCalledWith(0);
  });

  it('shows the JPEG preview for a HEIC photo and still downloads the original', () => {
    renderLightbox({
      entries: [
        {
          entityId: 'heic',
          kind: 'image',
          contentType: 'image/heic',
          thumbUrl: 'https://cdn.example.com/IMG_0001-preview.jpg',
          fullUrl: 'https://cdn.example.com/IMG_0001.HEIC',
          title: 'IMG_0001.HEIC',
        },
      ],
      index: 0,
    });

    expect(screen.getByAltText('IMG_0001.HEIC')).toHaveAttribute(
      'src',
      'https://cdn.example.com/IMG_0001-preview.jpg',
    );
    expect(screen.getByRole('button', { name: 'Open original' }).closest('a')).toHaveAttribute(
      'href',
      'https://cdn.example.com/IMG_0001.HEIC',
    );
  });

  it('says the photo could not load when a HEIC has no JPEG preview', () => {
    renderLightbox({
      entries: [
        {
          entityId: 'heic',
          kind: 'image',
          contentType: 'image/heic',
          thumbUrl: null,
          fullUrl: 'https://cdn.example.com/IMG_0001.HEIC',
          title: 'IMG_0001.HEIC',
        },
      ],
      index: 0,
    });

    expect(screen.getByText("Couldn't load this media.")).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('offers the original as a link that opens outside the viewer', () => {
    renderLightbox();

    // The icon button lives inside the anchor, so the anchor is reached through it.
    const original = screen.getByRole('button', { name: 'Open original' }).closest('a');

    expect(original).toHaveAttribute('href', 'https://cdn.example.com/2.jpg');
    expect(original).toHaveAttribute('target', '_blank');
  });
});
