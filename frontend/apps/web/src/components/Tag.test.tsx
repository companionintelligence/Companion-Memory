import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tag } from './Tag';

const PALETTE_RE = /bg-(?:red|orange|amber|lime|green|teal|sky|indigo|violet|rose)-\d+/;

function paletteClass(container: HTMLElement): string {
  const el = container.querySelector('[class*="bg-"]');

  return el?.className.match(PALETTE_RE)?.[0] ?? '';
}

describe('Tag', () => {
  it('renders the text, icon and children', () => {
    render(
      <Tag text="Travel" icon={<svg data-testid="icon" />}>
        <span>extra</span>
      </Tag>,
    );

    expect(screen.getByText('Travel')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByText('extra')).toBeInTheDocument();
  });

  it('picks a colour from the palette', () => {
    const { container } = render(<Tag text="Work" />);

    expect(paletteClass(container)).toMatch(PALETTE_RE);
  });

  it('is deterministic and case-insensitive for the same text', () => {
    const upper = render(<Tag text="Coffee" />);
    const lower = render(<Tag text="coffee" />);

    expect(paletteClass(upper.container)).toBe(paletteClass(lower.container));
    expect(paletteClass(upper.container)).not.toBe('');
  });
});
