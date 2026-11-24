import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { UserMessage } from './UserMessage';

describe('UserMessage', () => {
  it('renders the message content as markdown', () => {
    const { getByText } = renderWithProviders(<UserMessage content="hello **there**" />);

    expect(getByText('there').tagName).toBe('STRONG');
  });

  it('lets mobile messages use the conversation width while retaining the desktop cap', () => {
    const { container } = renderWithProviders(<UserMessage content="hi" />);

    expect(container.firstElementChild).toHaveClass('max-w-[94%]', 'device:max-w-[40%]', 'rounded-xl');
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
