import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders bold text and links', () => {
    render(<Markdown>{'Hello **world** and [a link](https://example.com)'}</Markdown>);

    expect(screen.getByText('world').tagName).toBe('STRONG');
    expect(screen.getByRole('link', { name: 'a link' })).toHaveAttribute('href', 'https://example.com');
  });

  it('renders unordered lists', () => {
    render(<Markdown>{'- one\n- two'}</Markdown>);

    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['one', 'two']);
  });

  it('renders GFM tables', () => {
    render(<Markdown>{'| A | B |\n| - | - |\n| 1 | 2 |'}</Markdown>);

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
  });

  it('renders nothing for empty content', () => {
    const { container } = render(<Markdown>{''}</Markdown>);

    expect(container).toBeEmptyDOMElement();
  });

  describe('inline', () => {
    // Verbatim from a feed Summary card, which rendered the asterisks literally
    // before these slots were routed through this component.
    const BULLET = '**High Communication Volume:** Three items were logged under Communications.';

    it('still renders emphasis', () => {
      render(<Markdown inline>{BULLET}</Markdown>);

      expect(screen.getByText('High Communication Volume:').tagName).toBe('STRONG');
      expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
    });

    it('omits the paragraph wrapper so it can live inside an li', () => {
      const { container } = render(<Markdown inline>{BULLET}</Markdown>);

      expect(container.querySelector('p')).toBeNull();
    });

    it('keeps the paragraph wrapper when not inline', () => {
      const { container } = render(<Markdown>{BULLET}</Markdown>);

      expect(container.querySelector('p')).not.toBeNull();
    });
  });
});
