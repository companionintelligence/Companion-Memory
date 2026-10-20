import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { MemoryHubSectionSkeleton } from './MemoryHubSkeletons';

function skeletonFor(pathname: string) {
  renderWithProviders(<MemoryHubSectionSkeleton pathname={pathname} />);

  return screen.getByRole('status');
}

/**
 * While a section's code downloads, MemoryHubLayout shows the placeholder that
 * section shows while its data loads, so the two waits look like one.
 */
describe('MemoryHubSectionSkeleton', () => {
  it('puts the explorer list placeholder under the filter bar on Events', () => {
    const status = skeletonFor('/memory/events');

    expect(status).toHaveTextContent('Loading');
    // ListSkeleton's ten rows, each led by a 36px glyph.
    expect(status.querySelectorAll('[data-slot="skeleton"].h-9.w-9')).toHaveLength(10);
  });

  it('draws round avatars for People', () => {
    expect(skeletonFor('/memory/people').querySelectorAll('.size-10.rounded-full')).toHaveLength(8);
  });

  it('draws square icons for Places and Receipts', () => {
    const status = skeletonFor('/memory/places');

    expect(status.querySelectorAll('.size-10.rounded-md')).toHaveLength(8);
    expect(status.querySelectorAll('.size-10.rounded-full')).toHaveLength(0);
  });

  it('draws tiles for Content', () => {
    const status = skeletonFor('/memory/content/42');

    expect(status).toHaveTextContent('Loading content');
    expect(status.querySelectorAll('.aspect-square')).toHaveLength(10);
  });

  it.each([
    ['/memory/things', 'Loading things'],
    ['/memory/notes', 'Loading notes'],
    ['/memory/tags', 'Loading tags'],
    ['/memory/chat/7', 'Loading chats'],
  ])('names what is loading on %s', (pathname, label) => {
    expect(skeletonFor(pathname)).toHaveTextContent(label);
  });

  it('hides the shapes from a screen reader, which hears the label alone', () => {
    const status = skeletonFor('/memory/people');

    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status.querySelector('[aria-hidden="true"]')).toContainElement(
      status.querySelector('[data-slot="skeleton"]') as HTMLElement,
    );
  });
});
