import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThinkBlock } from './ThinkBlock';

describe('ThinkBlock', () => {
  it('renders nothing when empty and not forced', () => {
    const { container } = render(<ThinkBlock content="   " />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders the shell when empty content is forced', () => {
    render(<ThinkBlock content="" renderEmptyContent />);

    expect(screen.getByText('AI thinking')).toBeInTheDocument();
  });

  it('renders the thinking content', () => {
    render(<ThinkBlock content="weighing the options" />);

    expect(screen.getByText('AI thinking')).toBeInTheDocument();
    expect(screen.getByText('weighing the options')).toBeInTheDocument();
  });

  it('collapses and expands when the header is clicked', () => {
    const { container } = render(<ThinkBlock content="details" />);
    const panel = () => container.querySelector('[class*="max-h-"]');

    expect(panel()?.className).toContain('max-h-none'); // expanded by default

    fireEvent.click(screen.getByRole('button'));
    expect(panel()?.className).toContain('max-h-0'); // collapsed
  });

  it('passes the streaming container to streamingRef', () => {
    const ref = vi.fn();
    render(<ThinkBlock content="streaming" streamingRef={ref} />);

    expect(ref).toHaveBeenCalled();
    expect(ref.mock.calls[0][0]).toBeInstanceOf(HTMLElement);
  });
});
