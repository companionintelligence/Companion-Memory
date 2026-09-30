import { htmlToText } from '../htmlToText';

describe('htmlToText', () => {
  it('returns empty string for empty/nullish input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText(null)).toBe('');
  });

  it('drops tags and keeps text', () => {
    expect(htmlToText('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('removes script/style contents, not just the tags', () => {
    const html = '<div>keep<style>.x{color:red}</style><script>alert(1)</script>me</div>';
    expect(htmlToText(html)).toBe('keepme');
  });

  it('removes head/title/noscript/template contents', () => {
    const html = '<html><head><title>Ignore</title></head><body>Visible</body></html>';
    expect(htmlToText(html)).toBe('Visible');
  });

  it('converts <br> and block-level closes to newlines', () => {
    expect(htmlToText('line1<br>line2')).toBe('line1\nline2');
    // A closing block tag immediately followed by another opening block tag is
    // a paragraph BREAK (blank line), matching the boundary this replaced,
    // which newlined the close and the next open as two independent
    // substitutions.
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\n\nb');
  });

  it('converts table cell boundaries to tabs so a label stays with its value', () => {
    expect(htmlToText('<table><tr><td>Total</td><td>$12.00</td></tr></table>')).toBe('Total\t$12.00');
  });

  it('decodes the full HTML5 named-entity table, not a hand-picked few', () => {
    // &rsquo; / &hellip; / &mdash; are exactly the entities the old per-source
    // regex decoders (facebook.ts, instagram.ts, mastodon.ts, evernote.ts)
    // did NOT know, because each one only hand-listed amp/lt/gt/quot/apos/nbsp.
    expect(htmlToText('&rsquo;&hellip;&mdash;')).toBe('’…—');
    expect(htmlToText('&amp; &lt;tag&gt; &quot;q&quot; &#39;a&#39; &nbsp;')).toBe('& <tag> "q" \'a\'');
  });

  it('decodes numeric entities, decimal and hex', () => {
    expect(htmlToText('&#65;&#x42;')).toBe('AB');
  });

  it('strips invisible characters that would otherwise pad text', () => {
    expect(htmlToText('a​b­c')).toBe('abc');
  });

  it('collapses whitespace runs and blank-line runs', () => {
    expect(htmlToText('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
    expect(htmlToText('a    b')).toBe('a b');
  });

  it('handles malformed/unclosed markup without throwing', () => {
    expect(() => htmlToText('<div><p>unclosed<span>nested')).not.toThrow();
    expect(htmlToText('<div><p>unclosed<span>nested')).toBe('unclosednested');
  });

  it('does not glue adjacent inline text runs together', () => {
    expect(htmlToText('<span>foo</span> <span>bar</span>')).toBe('foo bar');
  });

  it('drops a link destination by default', () => {
    expect(htmlToText('RSVP <a href="https://example.com/rsvp">here</a>.')).toBe('RSVP here.');
  });

  describe('preserveNewlines', () => {
    // Google Calendar's shape: markup and real newlines in one body.
    const mixed = '<b>Booked by</b>\nAda Lovelace\nada@example.com\n\nJoin: https://meet.example/abc';

    it('keeps a text newline as a line break', () => {
      expect(htmlToText(mixed, { preserveNewlines: true })).toBe(
        'Booked by\nAda Lovelace\nada@example.com\n\nJoin: https://meet.example/abc',
      );
    });

    it('is off by default: HTML whitespace runs the lines together', () => {
      expect(htmlToText(mixed)).toBe('Booked by Ada Lovelace ada@example.com Join: https://meet.example/abc');
    });

    it('adds to markup newlines under the same one-blank-line cap', () => {
      expect(htmlToText('code: <b>262</b>\n<br><br>\nSend it', { preserveNewlines: true })).toBe(
        'code: 262\n\nSend it',
      );
    });

    it('does not start a line with the indentation that followed a newline', () => {
      expect(htmlToText('<p>a</p>\n   b', { preserveNewlines: true })).toBe('a\n\nb');
    });
  });

  describe('keepLinkUrls', () => {
    const keep = (html: string) => htmlToText(html, { keepLinkUrls: true });

    it("prints a link's destination after text that does not show it", () => {
      expect(keep('RSVP <a href="https://example.com/rsvp">here</a>.')).toBe(
        'RSVP here (https://example.com/rsvp).',
      );
    });

    it('skips a destination the text already shows', () => {
      expect(keep('<a href="https://example.com/x">https://example.com/x</a>')).toBe('https://example.com/x');
      expect(keep('<a href="http://ethglobal.tv">ethglobal.tv</a>')).toBe('ethglobal.tv');
      expect(keep('<a href="https://zoom.us/j/1">Join at zoom.us/j/1</a>')).toBe('Join at zoom.us/j/1');
    });

    it('trusts address-like text over a tracker wrapping it', () => {
      expect(keep('<a href="https://list-manage.example/track/click?id=1">https://discord.gg/abc</a>')).toBe(
        'https://discord.gg/abc',
      );
    });

    it("unwraps Google's /url?q= redirect", () => {
      const href = 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fdoc&amp;sa=D&amp;ust=1';
      expect(keep(`the <a href="${href}">agenda</a>`)).toBe('the agenda (https://example.com/doc)');
    });

    it('prints a mailto address, and skips it when the text is the address', () => {
      expect(keep('<a href="mailto:ada@example.com?subject=hi">email Ada</a>')).toBe(
        'email Ada (ada@example.com)',
      );
      expect(keep('<a href="mailto:ada@example.com">ada@example.com</a>')).toBe('ada@example.com');
    });

    it('ignores tel:, javascript: and relative links', () => {
      expect(keep('<a href="tel:+1-310-555-0100">(310) 555-0100</a>')).toBe('(310) 555-0100');
      expect(keep('<a href="javascript:void(0)">menu</a>')).toBe('menu');
      expect(keep('<a href="/local">page</a>')).toBe('page');
    });

    it('prints the bare destination of a link with no text', () => {
      expect(keep('see<a href="https://example.com/img"><img src="x.png"></a>now')).toBe(
        'see https://example.com/img now',
      );
    });

    it('keeps the space and line break that followed the link text after the destination', () => {
      expect(keep('<a href="https://x.example/">go </a>now')).toBe('go (https://x.example/) now');
      expect(keep('<a href="https://x.example/">go<br></a>now')).toBe('go (https://x.example/)\nnow');
    });
  });
});
