import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderMessageHtml, sanitizeMessageHtml } from './messageHtml';

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
