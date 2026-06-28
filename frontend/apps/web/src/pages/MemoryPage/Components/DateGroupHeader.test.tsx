import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DateGroupHeader } from './DateGroupHeader';

describe('DateGroupHeader', () => {
  it('renders the label and is sticky', () => {
    const { container } = render(<DateGroupHeader label="Today" />);

    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain('sticky');
  });

  it('shows the count only when provided', () => {
    const { rerender } = render(<DateGroupHeader label="Today" />);
    expect(screen.queryByText('5')).not.toBeInTheDocument();

    rerender(<DateGroupHeader label="Today" count={5} />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('places the rule after the label when left-aligned (default)', () => {
    const { container } = render(<DateGroupHeader label="Today" />);
    const root = container.firstElementChild!;

    expect(root.lastElementChild?.className).toContain('flex-1');
  });

  it('places the rule before the label when right-aligned', () => {
    const { container } = render(<DateGroupHeader label="Today" align="right" />);
    const root = container.firstElementChild!;

    expect(root.firstElementChild?.className).toContain('flex-1');
  });
});
