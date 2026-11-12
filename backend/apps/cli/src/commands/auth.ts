import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ImportApiClient } from '../client';
import { CliError, type CliContext } from '../context';
import { MemoryGraphQLClient } from '../graphqlClient';
import { json } from '../output';

export interface StoredCredentials {
  serverUrl: string;
  apiKey: string;
  keyId?: string;
  keyPrefix?: string;
  userEmail?: string;
  updatedAt: string;
}

export interface LoginOptions {
  key?: string;
  username?: string;
  password?: string;
  keyName?: string;
  capability?: string;
  json?: boolean;
}

export interface LogoutOptions {
  revoke?: boolean;
  json?: boolean;
}

export interface WhoamiOptions {
  json?: boolean;
}

/**
 * Resolve the config directory from `env` when an environment root is present.
 *
 * Returning `null` when a synthetic `{}` environment is passed keeps unit tests
 * of `resolveTarget({}, {})` isolated from whatever credentials a developer has
 * saved in their own home directory.
 */
export function resolveCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
  fallbackToOsHome = false,
): string | null {
  if (env.CI_CONFIG_DIR) {
    return path.join(env.CI_CONFIG_DIR, 'credentials.json');
  }

  // When running under Vitest/Jest with the ambient process.env, ignore the
  // developer's personal home directory unless CI_CONFIG_DIR was explicitly set.
  if (!fallbackToOsHome && env === process.env && (env.VITEST || env.NODE_ENV === 'test')) {
    return null;
  }

  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'ci', 'credentials.json');
  }

  if (env.HOME) {
    return path.join(env.HOME, '.config', 'ci', 'credentials.json');
  }

  if (fallbackToOsHome) {
    return path.join(os.homedir(), '.config', 'ci', 'credentials.json');
  }

  return null;
}

export function readStoredCredentials(env: NodeJS.ProcessEnv = process.env): StoredCredentials | null {
  const filePath = resolveCredentialsPath(env, false);

  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoredCredentials>;

    if (typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0 && typeof parsed.serverUrl === 'string') {
      return {
        serverUrl: parsed.serverUrl,
        apiKey: parsed.apiKey,
        keyId: parsed.keyId,
        keyPrefix: parsed.keyPrefix,
        userEmail: parsed.userEmail,
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      };
    }
  } catch {
    // Corrupted or unreadable credentials file — ignore so `--api-key` or `ci login` can overwrite it.
  }

  return null;
}

export function writeStoredCredentials(
  credentials: StoredCredentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const filePath = resolveCredentialsPath(env, true)!;
  const dir = path.dirname(filePath);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);

  return filePath;
}

export function removeStoredCredentials(
  env: NodeJS.ProcessEnv = process.env,
): { removed: boolean; path: string } {
  const filePath = resolveCredentialsPath(env, true)!;

  if (!existsSync(filePath)) {
    return { removed: false, path: filePath };
  }

  unlinkSync(filePath);

  return { removed: true, path: filePath };
}

const VALID_CAPABILITIES = new Set(['read', 'write', 'full']);

/**
 * Authenticate with a Companion Memory appliance and persist the API key to
 * `~/.config/ci/credentials.json` (mode `0600`).
 *
 * Supports two headless flows:
 * 1. `--key <apiKey>` (or global `--api-key <apiKey>`): verifies the key against
 *    `GET /keys/check` and persists it.
 * 2. `--username <email> --password <password>`: exchanges credentials via
 *    `GET /authenticate/csrf` + `POST /authenticate`, mints a dedicated CLI API
 *    key via `POST /keys`, and persists it.
 */
export async function loginCommand(
  ctx: CliContext,
  options: LoginOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const explicitKey = options.key?.trim() || ctx.client.apiKey;
  const hasPasswordFlow = Boolean(options.username || options.password);

  if (explicitKey && !hasPasswordFlow) {
    // If `--key` was supplied on the subcommand rather than `--api-key` on the root,
    // verify using that key when talking to a real ImportApiClient.
    const verifyClient =
      options.key && ctx.client instanceof ImportApiClient
        ? new ImportApiClient({ baseUrl: ctx.client.baseUrl, apiKey: explicitKey })
        : ctx.client;
    const check = await verifyClient.checkApiKey();

    if (!check.valid) {
      throw new CliError('The API key was rejected by the appliance.');
    }

    let userEmail: string | undefined;

    try {
      const verifyGql =
        options.key && ctx.graphql instanceof MemoryGraphQLClient
          ? new MemoryGraphQLClient({ baseUrl: ctx.graphql.baseUrl, apiKey: explicitKey })
          : ctx.graphql;
      const me = await verifyGql.me();

      userEmail = me?.email;
    } catch {
      // `GET /keys/check` already succeeded; `me` is optional enrichment.
    }

    const savedPath = writeStoredCredentials(
      {
        serverUrl: ctx.client.baseUrl,
        apiKey: explicitKey,
        keyPrefix: explicitKey.slice(0, 11),
        userEmail,
        updatedAt: new Date().toISOString(),
      },
      env,
    );

    const payload = {
      ok: true,
      method: 'api-key' as const,
      serverUrl: ctx.client.baseUrl,
      userId: check.userId ?? null,
      userEmail: userEmail ?? null,
      credentialsPath: savedPath,
    };

    if (options.json) {
      json(ctx.term, payload);

      return;
    }

    ctx.term.out(`Logged in to ${ctx.client.baseUrl}${userEmail ? ` as ${userEmail}` : ''}.`);
    ctx.term.out(`Credentials saved to ${savedPath} (0600).`);

    return;
  }

  const username = options.username?.trim();
  const password = options.password;

  if (!username || !password) {
    throw new CliError(
      'Pass --key <apiKey> (or global --api-key) or both --username <email> and --password <password> to log in.',
    );
  }

  const capability = (options.capability ?? 'full').trim() as 'read' | 'write' | 'full';

  if (!VALID_CAPABILITIES.has(capability)) {
    throw new CliError('--capability must be read, write, or full.');
  }

  const keyName = options.keyName?.trim() || 'ci-cli';
  const { csrfToken } = await ctx.client.getCsrfToken();
  const { accessToken } = await ctx.client.authenticate({ username, password }, csrfToken);
  const created = await ctx.client.createApiKey({ name: keyName, capability }, accessToken);

  const savedPath = writeStoredCredentials(
    {
      serverUrl: ctx.client.baseUrl,
      apiKey: created.key,
      keyId: created.id,
      keyPrefix: created.keyPrefix,
      userEmail: username,
      updatedAt: new Date().toISOString(),
    },
    env,
  );

  const payload = {
    ok: true,
    method: 'password' as const,
    serverUrl: ctx.client.baseUrl,
    userEmail: username,
    keyId: created.id,
    keyName: created.name,
    keyPrefix: created.keyPrefix,
    capability: created.capability,
    credentialsPath: savedPath,
  };

  if (options.json) {
    json(ctx.term, payload);

    return;
  }

  ctx.term.out(`Logged in to ${ctx.client.baseUrl} as ${username}.`);
  ctx.term.out(`Minted API key ${created.keyPrefix}… (${created.name}, capability=${created.capability}).`);
  ctx.term.out(`Credentials saved to ${savedPath} (0600).`);
}

/**
 * Remove stored CLI credentials, optionally revoking the active API key on the appliance.
 */
export async function logoutCommand(
  ctx: CliContext,
  options: LogoutOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let revoked = false;

  if (options.revoke && ctx.client.apiKey) {
    const res = await ctx.client.revokeCurrentApiKey();

    revoked = Boolean(res.ok);
  }

  const { removed, path: filePath } = removeStoredCredentials(env);

  if (options.json) {
    json(ctx.term, { ok: true, removed, revoked, credentialsPath: filePath });

    return;
  }

  if (revoked) {
    ctx.term.out('Revoked active API key on the appliance.');
  }

  if (removed) {
    ctx.term.out(`Removed stored credentials at ${filePath}.`);
  } else {
    ctx.term.out(`No stored credentials file at ${filePath}.`);
  }
}

/**
 * Print the account the active API key resolves to.
 */
export async function whoamiCommand(ctx: CliContext, options: WhoamiOptions = {}): Promise<void> {
  const me = await ctx.graphql.me();

  if (!me) {
    throw new CliError('Not authenticated. Run `ci login` or set CI_API_KEY.');
  }

  const payload = {
    ...me,
    serverUrl: ctx.graphql.baseUrl,
  };

  if (options.json) {
    json(ctx.term, payload);

    return;
  }

  ctx.term.out(`user    ${me.name} <${me.email}>`);
  ctx.term.out(`id      ${me.id}`);
  ctx.term.out(`server  ${ctx.graphql.baseUrl}`);
}
