import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { BentoCard } from './BentoCard';

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

afterEach(() => setViewport(false));

describe('BentoCard', () => {
  it('keeps the desktop preview at 550×400', async () => {
    setViewport(false);
    renderWithProviders(<BentoCard title="Favorite meal found!" description={<p>A recipe for salad.</p>} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Favorite meal found!' })).toBeInTheDocument(),
    );
    expect(document.querySelector('.w-\\[550px\\]')).not.toBeNull();
    expect(document.querySelector('.h-\\[400px\\]')).not.toBeNull();
  });

  it('renders a compact tappable row on a phone', async () => {
    setViewport(true);
    renderWithProviders(
      <BentoCard
        title="Review notes from previous Engineering Strategy sessions"
        description={<p>Because you asked for a recap of last week.</p>}
        imageUrl="https://example.com/salad.jpg"
        onDismiss={() => undefined}
        dismissLabel="Dismiss action"
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('heading', {
          level: 3,
          name: 'Review notes from previous Engineering Strategy sessions',
        }),
      ).toBeInTheDocument(),
    );

    expect(document.querySelector('.w-\\[550px\\]')).toBeNull();
    expect(document.querySelector('.h-\\[400px\\]')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss action' })).toBeInTheDocument();
    expect(document.querySelector('img')).toHaveClass('h-14');
  });

  it('does not reserve an image slot on a phone when there is no image', async () => {
    setViewport(true);
    renderWithProviders(
      <BentoCard title="Call Maya" description={<p>She asked about Saturday.</p>} tags={['action']} />,
    );

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Call Maya' })).toBeInTheDocument());
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.h-14.w-14')).toBeNull();
  });
});
