import { describe, expect, it } from 'vitest';

import { escapeHtml, plainSlideText } from './escapeHtml';

describe('escapeHtml', () => {
  it('turns markup into text that innerHTML shows verbatim', () => {
    const subject =
      'Invoice <b>due</b><style>body{display:none}</style><img src="https://tracker.example/t.gif">';
    const host = document.createElement('div');

    host.innerHTML = escapeHtml(subject);

    expect(host.children).toHaveLength(0);
    expect(host.textContent).toBe(subject);
  });

  it('escapes the ampersand first, so text that looks like an entity stays as typed', () => {
    expect(escapeHtml('Tom & Jerry &lt;3')).toBe('Tom &amp; Jerry &amp;lt;3');
  });

  it('leaves quotes alone, since TimelineJS only writes these strings as element content', () => {
    expect(escapeHtml(`Mom's "big" day`)).toBe(`Mom's "big" day`);
  });
});

describe('plainSlideText', () => {
  it('escapes both the headline and the body', () => {
    expect(plainSlideText('<i>a</i>', 'b > c')).toEqual({
      headline: '&lt;i&gt;a&lt;/i&gt;',
      text: 'b &gt; c',
    });
  });
});
