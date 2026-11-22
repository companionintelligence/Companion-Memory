import { generateKeyPairSync } from 'node:crypto';

import { didKeyIdFor } from './didKeyId';
import {
  cleanPersonName,
  encodeInviteCode,
  handleFromName,
  hashInviteSecret,
  newInviteSecret,
  parseInviteCode,
  uniqueHandle,
} from './inviteCode';

const didKey = didKeyIdFor(
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
) as string;

const CODE = {
  endpoint: 'https://alice.example.com/api/agent/v1',
  didKey,
  secret: newInviteSecret(),
  name: 'Alice',
};

function codeOf(fields: Record<string, unknown>): string {
  return `cmi1.${Buffer.from(JSON.stringify(fields)).toString('base64url')}`;
}

describe('invite codes', () => {
  it('round-trips', () => {
    expect(parseInviteCode(encodeInviteCode(CODE))).toEqual(CODE);
  });

  it('tolerates whitespace a chat app adds when the code wraps', () => {
    const code = encodeInviteCode(CODE);

    expect(parseInviteCode(`  ${code.slice(0, 40)}\n${code.slice(40)} `)).toEqual(CODE);
  });

  it.each([
    ['another prefix', `cmi2.${encodeInviteCode(CODE).slice(5)}`],
    ['not base64url', 'cmi1.!!!'],
    ['not JSON', `cmi1.${Buffer.from('nope').toString('base64url')}`],
    [
      'an http address',
      codeOf({ e: 'http://alice.example.com/agent/v1', k: didKey, s: CODE.secret, n: 'A' }),
    ],
    ['no address', codeOf({ k: didKey, s: CODE.secret, n: 'A' })],
    ['a key that is not a did:key', codeOf({ e: CODE.endpoint, k: 'did:web:alice', s: CODE.secret, n: 'A' })],
    ['a short secret', codeOf({ e: CODE.endpoint, k: didKey, s: 'abc', n: 'A' })],
    ['a name of hidden characters only', codeOf({ e: CODE.endpoint, k: didKey, s: CODE.secret, n: '​‍' })],
    ['an enormous code', `cmi1.${'a'.repeat(3000)}`],
  ])('refuses %s', (_label, raw) => {
    expect(parseInviteCode(raw)).toBeNull();
  });

  it('strips hidden characters from the name rather than showing them', () => {
    const parsed = parseInviteCode(codeOf({ e: CODE.endpoint, k: didKey, s: CODE.secret, n: 'Al​ice‮' }));

    expect(parsed?.name).toBe('Alice');
  });

  it('stores a hash that is not the secret', () => {
    const secret = newInviteSecret();

    expect(hashInviteSecret(secret)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashInviteSecret(secret)).not.toBe(secret);
  });
});

describe('handles from names', () => {
  it.each([
    ['Alice Example', 'alice-example'],
    ['Zoë  Ångström', 'zoe-angstrom'],
    ['   ', 'peer'],
    ['李雷', 'peer'],
    ['a'.repeat(50), 'a'.repeat(32)],
  ])('%j → %j', (name, handle) => {
    expect(handleFromName(name)).toBe(handle);
  });

  it('finds the first free one', () => {
    expect(uniqueHandle('dana', new Set())).toBe('dana');
    expect(uniqueHandle('dana', new Set(['dana', 'dana-2']))).toBe('dana-3');
  });

  it('cleans names, and refuses empty ones', () => {
    expect(cleanPersonName('  Bob\n Smith ')).toBe('Bob Smith');
    expect(cleanPersonName('')).toBeNull();
    expect(cleanPersonName(42)).toBeNull();
  });
});
