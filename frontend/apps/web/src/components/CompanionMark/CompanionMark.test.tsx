import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { BrainMark } from '@/pages/SplashPage/SplashChrome';

import { CompanionMark } from './CompanionMark';

function markImage(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector('img');

  if (!img) {
    throw new Error('no mark image rendered');
  }

  return img;
}

describe('CompanionMark', () => {
  it('is one static image, decorative, whatever the placement asks for', () => {
    for (const animated of [false, true]) {
      const { container, unmount } = render(<CompanionMark animated={animated} />);
      const img = markImage(container);

      // Same stem the drawer test and the splash both rely on — never `logo`.
      expect(img.getAttribute('src')).toContain('companion-memory-brain');
      expect(img).toHaveAttribute('alt', '');
      expect(container.querySelectorAll('img')).toHaveLength(1);

      unmount();
    }
  });

  it('stays still in persistent chrome unless asked to animate', () => {
    const { container } = render(<CompanionMark className="size-8 rounded-full" />);
    const img = markImage(container);

    expect(img.className).toContain('size-8');
    expect(img.className).not.toContain('animate-in');
  });

  it('answers `animated` with a CSS entrance that reduced motion switches off', () => {
    const { container } = render(<CompanionMark animated />);
    const classes = markImage(container).className.split(/\s+/);

    // Every animation utility is behind `motion-safe:`, so `prefers-reduced-motion`
    // gets the still mark without any script having to look at the media query.
    expect(classes).toContain('motion-safe:animate-in');
    expect(
      classes.filter((c) => /(^|:)(animate|fade|zoom)-/.test(c) && !c.startsWith('motion-safe:')),
    ).toEqual([]);
  });
});

describe('BrainMark', () => {
  it('renders the same static mark as the rail, with a motion-safe entrance and no player', () => {
    const { container } = render(<BrainMark sizeClass="size-40" />);
    const img = markImage(container);
    const classes = img.className.split(/\s+/);

    expect(img.getAttribute('src')).toContain('companion-memory-brain');
    expect(classes).toContain('motion-safe:animate-in');
    expect(
      classes.filter((c) => /(^|:)(animate|fade|zoom)-/.test(c) && !c.startsWith('motion-safe:')),
    ).toEqual([]);
    // A canvas or svg element here would mean a player (or an inlined drawing)
    // crept back in; the hero is a plain image.
    expect(container.querySelector('canvas, svg')).toBeNull();
  });

  it('puts the size and the halo on a wrapper so the entrance cannot replace the glow', () => {
    const { container } = render(<BrainMark sizeClass="size-40" />);
    const wrapper = markImage(container).parentElement;

    expect(wrapper).toHaveClass('size-40');
    expect(wrapper?.className).toMatch(/drop-shadow-/);
    // The entrance utility animates `filter`; a drop-shadow on the same element
    // is dropped for the length of the animation and snaps back at the end.
    expect(markImage(container).className).not.toMatch(/drop-shadow-/);
  });
});
