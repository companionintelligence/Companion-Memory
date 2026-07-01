import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { UserMessage } from './UserMessage';

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : false,
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

describe('UserMessage', () => {
  it('renders the message content as markdown', () => {
    const { getByText } = renderWithProviders(<UserMessage content="hello **there**" />);

    expect(getByText('there').tagName).toBe('STRONG');
  });

  it('uses a wider max-width bubble on mobile', async () => {
    setViewport(true);
    const { container } = renderWithProviders(<UserMessage content="hi" />);

    await waitFor(() => expect(container.querySelector('.max-w-\\[60\\%\\]')).not.toBeNull());
  });

  it('uses a narrower max-width bubble on desktop', () => {
    setViewport(false);
    const { container } = renderWithProviders(<UserMessage content="hi" />);

    expect(container.querySelector('.max-w-\\[40\\%\\]')).not.toBeNull();
  });

  it('renders a timestamp when createdAt is provided', () => {
    const createdAt = '2026-01-15T10:00:00Z';
    const { container } = renderWithProviders(<UserMessage content="hi" createdAt={createdAt} />);

    expect(container.textContent).toContain(new Date(createdAt).toLocaleString());
  });

  it('omits the timestamp when createdAt is absent', () => {
    const { container } = renderWithProviders(<UserMessage content="hi" />);

    // Only the message text, no trailing date row.
    expect(container.querySelector('.text-right')).toBeNull();
  });
});
