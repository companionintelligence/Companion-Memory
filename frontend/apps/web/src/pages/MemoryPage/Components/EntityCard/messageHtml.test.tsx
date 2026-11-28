import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  cardMessageBody,
  isHtmlMessageBody,
  renderMessageBody,
  renderMessageHtml,
  sanitizeMessageHtml,
} from './messageHtml';

describe('sanitizeMessageHtml', () => {
  it('keeps the text and its structure', () => {
    expect(sanitizeMessageHtml('<p>Hi <b>there</b>,<br>see <em>you</em></p><ul><li>one</li></ul>')).toBe(
      '<p>Hi <b>there</b>,<br>see <em>you</em></p><ul><li>one</li></ul>',
    );
  });

  // Each of these loads something from the sender's server when the message is shown.
  it.each([
    ['an image', '<p>Hello</p><img src="https://tracker.example/open.gif?id=42">'],
    ['an image set', '<picture><source srcset="https://tracker.example/a.png"></picture><p>Hello</p>'],
    ['a style sheet', '<style>p { background: url(https://tracker.example/b.gif) }</style><p>Hello</p>'],
    ['an inline style', '<p style="background-image: url(https://tracker.example/c.gif)">Hello</p>'],
    [
      'a table background',
      '<table background="https://tracker.example/d.gif"><tr><td>Hello</td></tr></table>',
    ],
    ['a frame', '<iframe src="https://tracker.example/e"></iframe><p>Hello</p>'],
    ['a video', '<video poster="https://tracker.example/f.jpg"></video><p>Hello</p>'],
    ['a link ping', '<a href="https://example.com" ping="https://tracker.example/g">Hello</a>'],
  ])('removes %s, which would load from the sender', (_name, html) => {
    const clean = sanitizeMessageHtml(html);

    expect(clean).not.toContain('tracker.example');
    expect(clean).toContain('Hello');
  });

  it('removes a form and its fields, which could pose as a sign-in box', () => {
    const clean = sanitizeMessageHtml(
      '<form action="https://phish.example/login"><input name="password" type="password"><button>Sign in</button></form>',
    );

    expect(clean).not.toMatch(/<form|<input|<button|phish\.example/);
  });

  it.each([
    ['javascript:', '<a href="javascript:alert(1)">x</a>'],
    ['data:', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
  ])('drops a %s link target', (_name, html) => {
    expect(sanitizeMessageHtml(html)).toBe('<a>x</a>');
  });

  it('keeps web, mail and phone links', () => {
    expect(sanitizeMessageHtml('<a href="https://example.com/a">a</a>')).toBe(
      '<a href="https://example.com/a">a</a>',
    );
    expect(sanitizeMessageHtml('<a href="mailto:a@example.com">b</a>')).toBe(
      '<a href="mailto:a@example.com">b</a>',
    );
    expect(sanitizeMessageHtml('<a href="tel:+15550100">c</a>')).toBe('<a href="tel:+15550100">c</a>');
  });

  it("drops data and aria attributes, which the app's own styles act on", () => {
    // A toast's attributes pin the element over the whole app (sonner's global CSS).
    expect(
      sanitizeMessageHtml(
        '<div data-sonner-toaster data-sonner-theme="light"><p aria-label="Sign in" data-mounted="true">Hi</p></div>',
      ),
    ).toBe('<div><p>Hi</p></div>');
  });

  it('drops scripts and event handlers with what they hold', () => {
    const clean = sanitizeMessageHtml('<p onclick="steal()">Hi</p><script>steal()</script>');

    expect(clean).toBe('<p>Hi</p>');
  });

  it('shows plain text, as a text/plain body is stored, unchanged', () => {
    expect(sanitizeMessageHtml('Lunch at 1? Bring the notes.')).toBe('Lunch at 1? Bring the notes.');
  });
});

describe('renderMessageHtml', () => {
  it('opens links outside the app and sends no referrer', () => {
    const { container } = render(
      <div>{renderMessageHtml('<p>See <a href="https://example.com">this</a></p>')}</div>,
    );
    const link = container.querySelector('a');

    expect(link?.getAttribute('href')).toBe('https://example.com');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });
});

/** An email as a mail client writes it: a long <head> before any of the text a person reads. */
const NEWSLETTER = `<!DOCTYPE HTML>
<html><head><title></title>
<meta name="format-detection" content="date=no" />
<style>${'.x{color:red}'.repeat(120)}</style>
</head><body>
<table><tr><td><img src="https://s3.amazonaws.com/track/pixel.png" alt="" /></td></tr>
<tr><td><p>Prioritize your tomorrow. Today.</p>
<p>Read the <a href="https://www.example.com/disclosures">disclosures</a>.</p></td></tr></table>
</body></html>`;

describe('isHtmlMessageBody', () => {
  it.each([
    ['an HTML email', NEWSLETTER],
    ['a fragment', '<p>Hi</p>'],
    ['a line break', 'one<br>two'],
  ])('reads %s as HTML', (_label, body) => {
    expect(isHtmlMessageBody(body)).toBe(true);
  });

  it.each([
    ['a text message', 'See you at 6'],
    ['a heart', 'I <3 you'],
    ['a comparison', 'is a < b > c?'],
    ['an address in brackets', 'Kyle <kyle@example.com>'],
    ['an address that starts like a tag', 'On Tue, Pat <p.smith@example.com> wrote:'],
    ['more such addresses', '<b.jones@example.com> <i-team@example.com>'],
  ])('reads %s as text', (_label, body) => {
    expect(isHtmlMessageBody(body)).toBe(false);
  });

  // 300 KB of unclosed tags: a pattern that rescans to the end from each `<` takes many seconds here.
  // Timed in the test, since a synchronous test is never cut off by the timeout.
  it('decides quickly however many tags are left open', () => {
    const started = performance.now();

    expect(isHtmlMessageBody('<p '.repeat(100_000))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('renderMessageBody', () => {
  it('renders an HTML email as its text and links, with nothing it would load', () => {
    const { container } = render(<div>{renderMessageBody(NEWSLETTER)}</div>);

    expect(container).toHaveTextContent('Prioritize your tomorrow. Today.');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://www.example.com/disclosures');
    expect(container.querySelector('img, style, title, meta')).toBeNull();
    expect(container.textContent).not.toContain('<');
  });

  it('keeps a text message as written, line breaks and all', () => {
    const { container } = render(<div>{renderMessageBody('Line one\nLine two <3')}</div>);
    const text = container.querySelector('span');

    expect(text?.textContent).toBe('Line one\nLine two <3');
    expect(text?.className).toContain('whitespace-pre-wrap');
  });
});

describe('cardMessageBody', () => {
  it('keeps an HTML email whole, so the card shows its text and not an empty cleaned <head>', () => {
    expect(NEWSLETTER.length).toBeGreaterThan(1000);
    expect(cardMessageBody(NEWSLETTER)).toBe(NEWSLETTER);

    const { container } = render(<div>{renderMessageBody(cardMessageBody(NEWSLETTER))}</div>);
    expect(container).toHaveTextContent('Prioritize your tomorrow. Today.');
  });

  it('cuts a long text message short', () => {
    const text = 'word '.repeat(400);

    expect(cardMessageBody(text)).toBe(`${text.substring(0, 1000)}...`);
    expect(cardMessageBody('short')).toBe('short');
  });
});
