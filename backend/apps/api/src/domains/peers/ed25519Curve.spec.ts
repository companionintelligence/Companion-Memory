import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { isEd25519CurvePoint } from './ed25519Curve';

/**
 * [32 bytes in hex, whether they are a point on the curve, what they are].
 *
 * Decided by RFC 8032 section 5.1.3 decoding in Python (the (p+3)/8 square-root method, which is not
 * the Euler-criterion test the code uses), over 131 encodings; these are the 51 edge cases around every
 * small-order y, the 19 non-canonical y's and the all-zero and all-ones strings, plus 6 random strings
 * of each kind. A point is a point at either sign of x except where x is zero.
 */
const VECTORS: ReadonlyArray<readonly [string, boolean, string]> = [
  ['0000000000000000000000000000000000000000000000000000000000000000', true, 'y=0 (order 4) sign 0'],
  ['0000000000000000000000000000000000000000000000000000000000000080', true, 'y=0 (order 4) sign 1'],
  ['0100000000000000000000000000000000000000000000000000000000000000', true, 'y=1 sign 0 (identity) sign 0'],
  ['0100000000000000000000000000000000000000000000000000000000000080', false, 'y=1 sign 0 (identity) sign 1'],
  ['ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', true, 'y=p-1 sign 0 (order 2) sign 0'],
  [
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    false,
    'y=p-1 sign 0 (order 2) sign 1',
  ],
  ['0200000000000000000000000000000000000000000000000000000000000000', false, 'y=2 sign 0'],
  ['0200000000000000000000000000000000000000000000000000000000000080', false, 'y=2 sign 1'],
  ['0300000000000000000000000000000000000000000000000000000000000000', true, 'y=3 sign 0'],
  ['0300000000000000000000000000000000000000000000000000000000000080', true, 'y=3 sign 1'],
  ['ebffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p-2 sign 0'],
  ['ebffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', false, 'y=p-2 sign 1'],
  ['dbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', true, 'y=p-18 sign 0'],
  ['dbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', true, 'y=p-18 sign 1'],
  ['26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', true, 'y=y8 sign 0'],
  ['26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', true, 'y=y8 sign 1'],
  ['25e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', true, 'y=y8-1 sign 0'],
  ['25e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', true, 'y=y8-1 sign 1'],
  ['27e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', false, 'y=y8+1 sign 0'],
  ['27e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', false, 'y=y8+1 sign 1'],
  ['c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', true, 'y=p-y8 sign 0'],
  ['c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', true, 'y=p-y8 sign 1'],
  ['c6176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', false, 'y=p-y8-1 sign 0'],
  ['c6176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', false, 'y=p-y8-1 sign 1'],
  ['c8176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', true, 'y=p-y8+1 sign 0'],
  ['c8176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', true, 'y=p-y8+1 sign 1'],
  ['0900000000000000000000000000000000000000000000000000000000000000', true, 'y=9 (base point x=...) sign 0'],
  ['0900000000000000000000000000000000000000000000000000000000000080', true, 'y=9 (base point x=...) sign 1'],
  ['5866666666666666666666666666666666666666666666666666666666666666', true, 'y=4/5 (base point) sign 0'],
  ['58666666666666666666666666666666666666666666666666666666666666e6', true, 'y=4/5 (base point) sign 1'],
  ['edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+0 (non-canonical)'],
  ['eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+1 (non-canonical)'],
  ['efffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+2 (non-canonical)'],
  ['f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+3 (non-canonical)'],
  ['f1ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+4 (non-canonical)'],
  ['f2ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+5 (non-canonical)'],
  ['f3ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+6 (non-canonical)'],
  ['f4ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+7 (non-canonical)'],
  ['f5ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+8 (non-canonical)'],
  ['f6ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+9 (non-canonical)'],
  ['f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+10 (non-canonical)'],
  ['f8ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+11 (non-canonical)'],
  ['f9ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+12 (non-canonical)'],
  ['faffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+13 (non-canonical)'],
  ['fbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+14 (non-canonical)'],
  ['fcffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+15 (non-canonical)'],
  ['fdffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+16 (non-canonical)'],
  ['feffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+17 (non-canonical)'],
  ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', false, 'y=p+18 (non-canonical)'],
  ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', false, 'all 0xff'],
  ['0000000000000000000000000000000000000000000000000000000000000000', true, 'all zero'],
  ['20ccaec926fdd79a19699da22b6cde4c2bf1a9bfbfc2749aca502f2b064e44e5', true, 'random on curve'],
  ['e69178a80d79726f9f58d59820fc3a1bd93e07b59c82cdfdfbd00eb8b9c43380', true, 'random on curve'],
  ['12d9664bc0640a277288b14084cfacf3ed45539eaedad1416644a4b915a2d5ff', true, 'random on curve'],
  ['d55e7e6fb8985eeb1dbec4aa3ef17f67981202a320939943e4cb28d9aad076f5', true, 'random on curve'],
  ['cf4f8bb5466b4358af746965f5a83552bb5f160d08d580246d84c8e69089dd49', true, 'random on curve'],
  ['9fa172c584f48b74d65504b53a869f5dfab2874cc54db9d3230a449dfcd33fab', true, 'random on curve'],
  ['f356de0c7cd2117a90e0f42f7a29d58f601c7f448bdffb6e0bc9eeb384bcbec2', false, 'random off curve'],
  ['9f99b43312166e0be83d241194417752206eff4b0bd4e61324a257fc020b6404', false, 'random off curve'],
  ['ed95958639d5cecd83dc66c91d2abde5bf441e365391247759f61aaa82062e2c', false, 'random off curve'],
  ['0e9e0917e14b15ce79fc067c0a705198b99926b927c5df9e20ebc1986bac4ed9', false, 'random off curve'],
  ['ab8980cf1f31d567fd376578427c81962568742580138727fa9c18fe9ac15f1b', false, 'random off curve'],
  ['39ba162414cdbeba4b381f7cc1f96079b1af6c22a195068da0b5eaa9a25ecd8b', false, 'random off curve'],
];

describe('isEd25519CurvePoint', () => {
  it.each(VECTORS.map(([hex, onCurve, note]) => ({ hex, onCurve, note })))(
    '$note: $onCurve',
    ({ hex, onCurve }) => {
      expect(isEd25519CurvePoint(Uint8Array.from(Buffer.from(hex, 'hex')))).toBe(onCurve);
    },
  );

  it('accepts every key Node generates', () => {
    for (let i = 0; i < 300; i += 1) {
      const { publicKey } = generateKeyPairSync('ed25519');
      const x = publicKey.export({ format: 'jwk' }).x as string;

      expect(isEd25519CurvePoint(Uint8Array.from(Buffer.from(x, 'base64url')))).toBe(true);
    }
  });

  it('refuses about half of all random strings, which are not points', () => {
    let points = 0;
    for (let i = 0; i < 1000; i += 1) {
      points += isEd25519CurvePoint(Uint8Array.from(randomBytes(32))) ? 1 : 0;
    }

    // Binomial(1000, 1/2) has a standard deviation of about 16; this window is eight of them wide.
    expect(points).toBeGreaterThan(370);
    expect(points).toBeLessThan(630);
  });

  it('refuses anything that is not exactly 32 bytes of a Uint8Array', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const key = Uint8Array.from(Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'));

    expect(isEd25519CurvePoint(key)).toBe(true);
    expect(isEd25519CurvePoint(key.subarray(0, 31))).toBe(false);
    expect(isEd25519CurvePoint(Uint8Array.of(...key, 0))).toBe(false);
    expect(isEd25519CurvePoint(new Uint8Array(0))).toBe(false);
    expect(isEd25519CurvePoint(Array.from(key) as unknown as Uint8Array)).toBe(false);
    expect(isEd25519CurvePoint(Buffer.from(key).toString('hex') as unknown as Uint8Array)).toBe(false);
    expect(isEd25519CurvePoint(null as unknown as Uint8Array)).toBe(false);
    expect(isEd25519CurvePoint(undefined as unknown as Uint8Array)).toBe(false);
  });
});
