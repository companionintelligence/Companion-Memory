import { committedSecretNames, enforceNoCommittedSecrets } from '../committedSecrets';

/** What a stack built from an untouched .env.default runs with. */
const FROM_TEMPLATE = {
  AUTH_TOKEN_SECRET: 'replace-me-auth-token-secret-00000000000000000000000000000000000',
  AUTH_SESSION_PEPPER: 'replace-me-auth-session-pepper-000000000000000000000000000000000',
  OBJECT_STORE_PASSWORD: 'replace-me-object-store-pass-000',
};

const MINTED = {
  AUTH_TOKEN_SECRET: '9f2c4e81a7d35b60c1e8f4a2d97b3c05e6a1f8d24c7b90e3a5d1c6f8b2e4a7d9',
  AUTH_SESSION_PEPPER: '3b7e1d9a5c2f8e4b6a0d3c7f1e9b5a2d8c4f6e0a1b3d5c7e9f2a4b6c8d0e1f3a',
  OBJECT_STORE_PASSWORD: 'c4f1a8e2b6d93e7f0a5c1b8d4e6f2a9c',
};

describe('committedSecretNames', () => {
  it('names every replace-me- placeholder', () => {
    expect(committedSecretNames(FROM_TEMPLATE)).toEqual([
      'AUTH_TOKEN_SECRET',
      'AUTH_SESSION_PEPPER',
      'OBJECT_STORE_PASSWORD',
    ]);
  });

  it("names a secret that fell back to config/default.json's literal variable name", () => {
    // An unset AUTH_TOKEN_SECRET makes node-config use the string "AUTH_TOKEN_SECRET".
    expect(committedSecretNames({ ...MINTED, AUTH_TOKEN_SECRET: 'AUTH_TOKEN_SECRET' })).toEqual([
      'AUTH_TOKEN_SECRET',
    ]);
  });

  it('passes real values and leaves empty ones to their own checks', () => {
    expect(committedSecretNames(MINTED)).toEqual([]);
    // Empty is "not configured" (PowerSync off, sidecar secret missing), which
    // other checks own; it is not a committed value.
    expect(committedSecretNames({ POWERSYNC_JWT_SECRET: '' })).toEqual([]);
    // Only a prefix counts: a random value that happens to contain the words does not.
    expect(committedSecretNames({ AUTH_CSRF_TOKEN_SECRET: 'x-replace-me-x' })).toEqual([]);
  });
});

describe('enforceNoCommittedSecrets', () => {
  it('refuses to boot in production mode, naming the variables', () => {
    expect(() => enforceNoCommittedSecrets(FROM_TEMPLATE, 'production', jest.fn())).toThrow(
      /AUTH_TOKEN_SECRET, AUTH_SESSION_PEPPER, OBJECT_STORE_PASSWORD still hold a value committed/,
    );
  });

  it('names a single variable in the singular', () => {
    expect(() =>
      enforceNoCommittedSecrets(
        { ...MINTED, AUTH_TOKEN_SECRET: 'AUTH_TOKEN_SECRET' },
        'production',
        jest.fn(),
      ),
    ).toThrow(/^\[configuration\] AUTH_TOKEN_SECRET still holds a value committed/);
  });

  it('only warns in development, so an existing developer .env keeps working', () => {
    const warn = jest.fn();

    expect(() => enforceNoCommittedSecrets(FROM_TEMPLATE, 'development', warn)).not.toThrow();
    expect(() => enforceNoCommittedSecrets(FROM_TEMPLATE, undefined, warn)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/env-secrets-cli\.ts mint \.env/);
  });

  it('says nothing under test, and nothing at all when every secret is real', () => {
    const warn = jest.fn();

    enforceNoCommittedSecrets(FROM_TEMPLATE, 'test', warn);
    expect(() => enforceNoCommittedSecrets(MINTED, 'production', warn)).not.toThrow();
    enforceNoCommittedSecrets(MINTED, 'development', warn);

    expect(warn).not.toHaveBeenCalled();
  });
});
