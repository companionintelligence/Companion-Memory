import { decodeHeaderField } from '../email_mime';

describe('RFC 2047 encoded-word decoding', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(decodeHeaderField('Hello World')).toBe('Hello World');
  });

  it('decodes a single base64-encoded UTF-8 subject', () => {
    // "Привет, мир!" in UTF-8 → base64
    const encoded = '=?UTF-8?B?0J/RgNC40LLQtdGCLCDQvNC40YAh?=';
    expect(decodeHeaderField(encoded)).toBe('Привет, мир!');
  });

  it('decodes Q-encoding with underscore-as-space', () => {
    // "Olá Mundo" in Q-encoding (á = =C3=A1 in UTF-8)
    const encoded = '=?UTF-8?Q?Ol=C3=A1_Mundo?=';
    expect(decodeHeaderField(encoded)).toBe('Olá Mundo');
  });

  it('collapses whitespace between adjacent encoded words', () => {
    // Two halves of "café" split across encoded words.
    const encoded = '=?UTF-8?Q?caf?= =?UTF-8?Q?=C3=A9?=';
    expect(decodeHeaderField(encoded)).toBe('café');
  });

  it('keeps whitespace between encoded word and ascii run', () => {
    const encoded = '=?UTF-8?Q?caf=C3=A9?= au lait';
    expect(decodeHeaderField(encoded)).toBe('café au lait');
  });

  it('leaves malformed encoded-words alone', () => {
    expect(decodeHeaderField('=?BOGUS?')).toBe('=?BOGUS?');
  });

  it('decodes a declared us-ascii charset as ascii, not utf8', () => {
    const encoded = '=?us-ascii?Q?Hello_World?=';
    expect(decodeHeaderField(encoded)).toBe('Hello World');
  });

  it('decodes an ISO-8859-1 (Latin-1) encoded-word correctly, not as mojibake', () => {
    // "café" in ISO-8859-1/Latin-1: 'é' is the single byte 0xE9, Q-encoded as
    // "=E9". Previously every charset other than us-ascii was forced through
    // as UTF-8, and the lone 0xE9 byte — an invalid UTF-8 lead byte — decoded
    // to the replacement character instead of 'é'. decodeHeaderField now goes
    // through the shared charset-aware decodeWithCharset (see email_mime.ts).
    const encoded = '=?ISO-8859-1?Q?caf=E9?=';
    expect(decodeHeaderField(encoded)).toBe('café');
  });

  it('decodes a windows-1252 encoded-word correctly', () => {
    // "€100" — the Euro sign is 0x80 in windows-1252 (undefined in Latin-1
    // proper, which is why windows-1252 and ISO-8859-1 are not the same
    // charset despite sharing a label colloquially).
    const encoded = '=?windows-1252?Q?=80100?=';
    expect(decodeHeaderField(encoded)).toBe('€100');
  });
});
