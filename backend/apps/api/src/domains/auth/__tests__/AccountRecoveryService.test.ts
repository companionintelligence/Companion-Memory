import { recoveryCodeDigest } from '../services/AccountRecoveryService';

describe('recovery code normalization', () => {
  const code = `CMR-${'12ab34cd56'.repeat(4)}`;

  it('accepts case, spaces, and separators without changing the digest', () => {
    expect(recoveryCodeDigest(`  ${code.toLowerCase().replaceAll('-', ' ')}  `)).toEqual(
      recoveryCodeDigest(code),
    );
    expect(recoveryCodeDigest(code)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['', 'not-a-code', `CMR-${'a'.repeat(39)}`, `CMR-${'a'.repeat(41)}`, `CMR-${'g'.repeat(40)}`])(
    'refuses malformed recovery code %s',
    (value) => {
      expect(recoveryCodeDigest(value)).toBeNull();
    },
  );
});
