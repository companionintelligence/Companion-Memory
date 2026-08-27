import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { initialsFor, paletteFor, PersonAvatar } from './PersonAvatar';

/**
 * WCAG 2.1 relative-luminance contrast ratio, computed the same way a real
 * contrast checker does — not eyeballed. This is the same formula the
 * component's own doc comment cites the numbers from; recomputing it here
 * means a future edit to the palette that regresses contrast fails a test
 * instead of only a code-review read-through.
 */
function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);

  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const cs = c / 255;

    return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexToRgb(hexA));
  const lumB = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];

  return (lighter + 0.05) / (darker + 0.05);
}

describe('PersonAvatar', () => {
  it('renders a photo when avatarUrl is present', () => {
    render(<PersonAvatar name="Ada Lovelace" avatarUrl="https://example.com/ada.png" />);

    const img = screen.getByRole('img');
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'https://example.com/ada.png');
  });

  it('prefixes a relative avatarUrl with /static', () => {
    render(<PersonAvatar name="Ada Lovelace" avatarUrl="/avatars/ada.png" />);

    expect(screen.getByRole('img')).toHaveAttribute('src', '/static/avatars/ada.png');
  });

  it('renders a data: URI as-is, never prefixing it with /static', () => {
    // vcard.ts embeds a contact's photo as exactly this shape
    // (data:image/jpeg;base64,...). Before this case existed it fell into the
    // relative-path branch above and became `/staticdata:image/jpeg;base64,...`
    // — a path that cannot resolve to anything, so it 404s and every
    // vCard-imported photo silently showed initials instead. Confirmed against
    // a real 4,697-person import: this was not a hypothetical edge case, it
    // was the common case for every contact that had a photo at all.
    const dataUri = 'data:image/jpeg;base64,/9j/AAA';

    render(<PersonAvatar name="Ada Lovelace" avatarUrl={dataUri} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', dataUri);
  });

  it('renders a data:image/png URI as-is too, not just jpeg', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';

    render(<PersonAvatar name="Ada Lovelace" avatarUrl={dataUri} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', dataUri);
  });

  it('renders initials, not a broken-image glyph, when there is no avatarUrl', () => {
    render(<PersonAvatar name="Ada Lovelace" avatarUrl={null} />);

    const fallback = screen.getByRole('img');
    expect(fallback.tagName).not.toBe('IMG');
    expect(fallback).toHaveTextContent('AL');
  });

  it('falls back to initials when the photo URL 404s, rather than leaving a broken image', () => {
    render(<PersonAvatar name="Ada Lovelace" avatarUrl="https://example.com/missing.png" />);

    const img = screen.getByRole('img');
    expect(img.tagName).toBe('IMG');

    fireEvent.error(img);

    const fallback = screen.getByRole('img');
    expect(fallback.tagName).not.toBe('IMG');
    expect(fallback).toHaveTextContent('AL');
  });

  it('gives a new avatarUrl its own chance to load after a previous one failed', () => {
    const { rerender } = render(
      <PersonAvatar name="Ada Lovelace" avatarUrl="https://example.com/broken.png" />,
    );

    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('img').tagName).not.toBe('IMG');

    rerender(<PersonAvatar name="Ada Lovelace" avatarUrl="https://example.com/working.png" />);

    const img = screen.getByRole('img');
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'https://example.com/working.png');
  });

  describe('initialsFor', () => {
    it('takes the first letter of a one-word name', () => {
      expect(initialsFor('Cher')).toBe('C');
    });

    it('takes the first letter of the first two words of a multi-word name', () => {
      expect(initialsFor('Ada Lovelace')).toBe('AL');
      expect(initialsFor('Mary Jane Watson')).toBe('MJ');
    });

    it('skips leading punctuation to find a letter, rather than initialing on it', () => {
      // The exact shape of the "…abc123" id-fragment labels this app already
      // shows for an unnamed counterparty.
      expect(initialsFor('Peer …sam001')).toBe('PS');
    });

    it('falls back to "?" for a blank or symbol-only label', () => {
      expect(initialsFor('')).toBe('?');
      expect(initialsFor('   ')).toBe('?');
      expect(initialsFor(null)).toBe('?');
      expect(initialsFor(undefined)).toBe('?');
      expect(initialsFor('…')).toBe('?');
    });

    it('is case-insensitive on input and always uppercases the result', () => {
      expect(initialsFor('ada lovelace')).toBe('AL');
    });
  });

  describe('paletteFor', () => {
    it('is deterministic: the same label always yields the same colour', () => {
      const a = paletteFor('Ada Lovelace');
      const b = paletteFor('Ada Lovelace');

      expect(a).toEqual(b);
    });

    it('every palette entry clears WCAG AA 4.5:1 for normal text', () => {
      // Enumerate the palette by hitting it with enough distinct seeds to
      // observe every entry at least once, rather than hard-coding the
      // palette a second time in the test.
      const seen = new Map<string, string>();

      for (let i = 0; i < 500; i += 1) {
        const { bg, fg } = paletteFor(`seed-${i}`);
        seen.set(bg, fg);
      }

      // Guards the "small" in "fixed, small palette" — this pins the count so
      // a future edit that quietly grows or shrinks the palette is visible
      // here, not just in a diff of the component.
      expect(seen.size).toBe(8);

      for (const [bg, fg] of seen) {
        const ratio = contrastRatio(bg, fg);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});
