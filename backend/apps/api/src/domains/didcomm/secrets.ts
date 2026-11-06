import { DidcommError } from './errors';
import { parsePrivateJwk, type PrivateJwk } from './jwk';

/**
 * Where the private keys come from.
 *
 * The library never stores a key. It asks a {@link SecretsResolver} for the private JWK behind a
 * `kid` at the moment it needs one, so a deployment can back it with the same vault, keychain or
 * database column that holds the rest of its secrets, and can refuse (return `undefined`) for a key
 * it does not hold. {@link InMemorySecretsResolver} is for tests and for short-lived identities.
 *
 * Nothing in this domain logs, serializes or returns a private JWK except `getSecret` itself.
 */
export interface SecretsResolver {
  /** The private key with this exact id (a full DID URL), or `undefined` when this agent does not hold it. */
  getSecret(kid: string): Promise<PrivateJwk | undefined>;
}

export class InMemorySecretsResolver implements SecretsResolver {
  private readonly secrets = new Map<string, PrivateJwk>();

  constructor(secrets: PrivateJwk[]) {
    for (const secret of secrets) {
      const jwk = parsePrivateJwk(secret);

      if (!jwk.kid) {
        throw new DidcommError('invalid-argument', 'every secret needs a "kid" (its full DID URL)');
      }

      if (this.secrets.has(jwk.kid)) {
        throw new DidcommError('invalid-argument', `duplicate secret ${jwk.kid}`);
      }

      this.secrets.set(jwk.kid, jwk);
    }
  }

  async getSecret(kid: string): Promise<PrivateJwk | undefined> {
    return this.secrets.get(kid);
  }

  /** Ids of the keys held, for diagnostics. Never the keys. */
  kids(): string[] {
    return [...this.secrets.keys()];
  }
}
