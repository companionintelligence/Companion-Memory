import { decodeAttributedBody } from '../attributed_body';

/**
 * Build a typedstream blob with the same byte layout chat.db writes.
 *
 * The two shapes observed in a real archive differ only in the archived class
 * (`NSAttributedString` vs `NSMutableAttributedString`) and in the reference
 * tag before the type code, so both are parameterised here. The text is
 * synthetic — the layout is what is under test, not anyone's messages.
 */
function typedstream(text: string, opts: { mutable?: boolean; refTag?: number } = {}): Buffer {
  const { mutable = true, refTag = mutable ? 0x95 : 0x94 } = opts;
  const body = Buffer.from(text, 'utf8');

  // Length: a literal byte under 128, otherwise typedstream's uint16 escape.
  const len =
    body.length < 0x80
      ? Buffer.from([body.length])
      : Buffer.concat([
          Buffer.from([0x81]),
          (() => {
            const b = Buffer.alloc(2);
            b.writeUInt16LE(body.length);
            return b;
          })(),
        ]);

  return Buffer.concat([
    Buffer.from([0x04, 0x0b]),
    Buffer.from('streamtyped', 'ascii'),
    Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    Buffer.from(mutable ? 'NSMutableAttributedString' : 'NSAttributedString', 'ascii'),
    Buffer.from([0x00, 0x84, 0x84, 0x08]),
    Buffer.from('NSObject', 'ascii'),
    Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84]),
    Buffer.from('NSString', 'ascii'),
    Buffer.from([0x01, refTag, 0x84, 0x01, 0x2b]),
    len,
    body,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]), // trailing attribute run
  ]);
}

describe('decodeAttributedBody', () => {
  it('reads a short body (single-byte length)', () => {
    expect(decodeAttributedBody(typedstream('see you at 6'))).toBe('see you at 6');
  });

  it('reads a body from the immutable NSAttributedString shape', () => {
    expect(decodeAttributedBody(typedstream('ok', { mutable: false }))).toBe('ok');
  });

  it('reads a long body via the uint16 length escape', () => {
    // 200 chars forces the 0x81 escape; a single-byte length cannot express it.
    const long = 'x'.repeat(200);
    expect(decodeAttributedBody(typedstream(long))).toBe(long);
  });

  it('reads a body sitting exactly on the 128-byte encoding boundary', () => {
    const at = 'y'.repeat(128);
    expect(decodeAttributedBody(typedstream(at))).toBe(at);
  });

  it('preserves multi-byte UTF-8 rather than truncating on byte length', () => {
    // The length prefix counts BYTES, not characters — an emoji is 4 of them,
    // so a decoder that treated it as a character count would cut the string.
    const text = 'café 🎉 déjà vu';
    expect(decodeAttributedBody(typedstream(text))).toBe(text);
  });

  it('keeps a U+FFFC attachment placeholder, which is real message content', () => {
    expect(decodeAttributedBody(typedstream('￼ caption'))).toBe('￼ caption');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', Buffer.alloc(0)],
    ['not a typedstream', Buffer.from('just some bytes', 'utf8')],
  ])('returns undefined for %s input', (_label, input) => {
    expect(decodeAttributedBody(input as Buffer)).toBeUndefined();
  });

  it('returns undefined when the length runs past the end of the blob', () => {
    const blob = typedstream('hello world');
    const at = blob.indexOf(Buffer.from('NSString', 'ascii')) + 'NSString'.length + 5;
    blob[at] = 0x7f; // claim 127 body bytes
    // Clip so only 5 remain, and clip on a boundary that leaves those 5 VALID
    // UTF-8. If the over-claimed tail were invalid, the UTF-8 guard would
    // reject it and this test would pass without exercising the bounds check
    // at all — which is exactly what an earlier version of it did.
    const clipped = blob.subarray(0, at + 1 + 5);
    expect(decodeAttributedBody(clipped)).toBeUndefined();
  });

  it('returns undefined rather than a mangled string on invalid UTF-8', () => {
    const blob = typedstream('abcd');
    const at = blob.indexOf(Buffer.from('NSString', 'ascii')) + 'NSString'.length + 6;
    blob[at] = 0xff; // a byte that cannot begin a UTF-8 sequence
    expect(decodeAttributedBody(blob)).toBeUndefined();
  });

  it('accepts a Uint8Array as well as a Buffer', () => {
    const asArray = new Uint8Array(typedstream('from a Uint8Array'));
    expect(decodeAttributedBody(asArray)).toBe('from a Uint8Array');
  });
});
