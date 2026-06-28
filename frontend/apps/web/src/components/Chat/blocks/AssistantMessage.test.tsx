import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessage } from './AssistantMessage';

describe('AssistantMessage', () => {
  it('renders the content as markdown', () => {
    render(<AssistantMessage content="the **answer**" />);

    expect(screen.getByText('answer').tagName).toBe('STRONG');
  });

  it('renders nothing when empty and not forced', () => {
    const { container } = render(<AssistantMessage content="   " />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the shell when empty content is forced', () => {
    const { container } = render(<AssistantMessage content="" renderEmptyContent />);

    expect(container.querySelector('.streaming-content')).not.toBeNull();
  });

  it('passes the streaming container to streamingRef', () => {
    const ref = vi.fn();
    render(<AssistantMessage content="hi" streamingRef={ref} />);

    expect(ref).toHaveBeenCalled();
    expect(ref.mock.calls[0][0]).toBeInstanceOf(HTMLElement);
  });

  it('renders a timestamp when createdAt is provided', () => {
    const createdAt = '2026-01-15T10:00:00Z';
    const { container } = render(<AssistantMessage content="hi" createdAt={createdAt} />);

    expect(container.textContent).toContain(new Date(createdAt).toLocaleString());
  });
});
