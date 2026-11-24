import { MEMORY_LOGO_DATA_URI } from '../utils/connectMemoryLogo';

/**
 * The consent page renders under a nonce-only CSP with `img-src data:`, so the
 * logo has to stay an inlined data URI, and it is sized for a 56px slot at up to
 * 4x. Pin that contract so a re-export of the artwork cannot quietly change it:
 * a lossy VP8 webp (a bare `VP8 ` chunk, not `VP8X` or `VP8L`, so no alpha
 * channel to composite) at exactly 256x256.
 */
const PREFIX = 'data:image/webp;base64,';

function decode(): Buffer {
  return Buffer.from(MEMORY_LOGO_DATA_URI.slice(PREFIX.length), 'base64');
}

describe('MEMORY_LOGO_DATA_URI', () => {
  it('is an inlined webp data URI', () => {
    expect(MEMORY_LOGO_DATA_URI.startsWith(PREFIX)).toBe(true);
    expect(MEMORY_LOGO_DATA_URI.slice(PREFIX.length)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('is a complete RIFF/WEBP file holding one lossy VP8 chunk', () => {
    const bytes = decode();

    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    // RIFF size counts everything after its own 8-byte header.
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    expect(bytes.toString('ascii', 12, 16)).toBe('VP8 ');
  });

  it('is 256x256', () => {
    const bytes = decode();

    // 'VP8 ' + chunk size (4) + 3-byte frame tag, then the 3-byte start code and
    // two little-endian 16-bit fields whose low 14 bits are width and height.
    expect([...bytes.subarray(23, 26)]).toEqual([0x9d, 0x01, 0x2a]);
    expect(bytes.readUInt16LE(26) & 0x3fff).toBe(256);
    expect(bytes.readUInt16LE(28) & 0x3fff).toBe(256);
  });

  it('stays small enough to inline in a page (under 20 KB of base64)', () => {
    expect(MEMORY_LOGO_DATA_URI.length - PREFIX.length).toBeLessThan(20_000);
  });
});
