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
});
