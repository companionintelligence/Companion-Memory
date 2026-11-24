/**
 * Secrets that still hold a value committed to this repository.
 *
 * Two kinds: a `replace-me-...` placeholder from `.env.default` (which `make init`
 * copied into `.env` as is until it learned to mint real values), and the
 * variable's own name, which is what `config/default.json` falls back to when the
 * variable is unset (`"authTokenSecret": "AUTH_TOKEN_SECRET"`). Anyone who has
 * read the repo can sign sessions and tokens, or read the object store, with
 * either. setup-secrets mints real values on every appliance, so in production
 * mode one of these means a hand-made `.env` (the staging profile reads one) or a
 * secret that never arrived.
 *
 * Production mode refuses to boot. Development warns: existing developer `.env`
 * files carry the placeholders and their stacks must keep starting. Tests are
 * left alone.
 */
export const PLACEHOLDER_PREFIX = 'replace-me-';

/** The env names, in the order given, whose value is committed to the repo. An empty value is not one. */
export function committedSecretNames(secrets: Record<string, string>): string[] {
  return Object.entries(secrets)
    .filter(([name, value]) => value.startsWith(PLACEHOLDER_PREFIX) || value === name)
    .map(([name]) => name);
}

export function enforceNoCommittedSecrets(
  secrets: Record<string, string>,
  nodeEnv: string | undefined,
  warn: (message: string) => void = console.warn,
): void {
  const names = committedSecretNames(secrets);

  if (names.length === 0 || nodeEnv === 'test') {
    return;
  }

  const message =
    `[configuration] ${names.join(', ')} still ${names.length === 1 ? 'holds' : 'hold'} a value committed to the repository ` +
    "(a replace-me- placeholder from .env.default, or the variable's own name). Anyone with the " +
    'repo could sign sessions and tokens or read the object store with it. Set real random values; ' +
    'for a dev .env, `yarn tsx scripts/dev-stack/env-secrets-cli.ts mint .env` replaces the placeholders.';

  if (nodeEnv === 'production') {
    throw new Error(message);
  }

  warn(message);
}
