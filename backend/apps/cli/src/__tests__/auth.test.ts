import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loginCommand,
  logoutCommand,
  readStoredCredentials,
  whoamiCommand,
} from '../commands/auth';
import { CliError } from '../context';
import { resolveTarget } from '../program';

import { harness } from './support/harness';

describe('ci auth (login / logout / whoami)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ci-cli-auth-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('verifies an API key via /keys/check and saves it with 0600 permissions', async () => {
    const ctx = harness(
      {
        baseUrl: 'http://appliance.local:3030',
        apiKey: 'ci_live_key_123456',
        checkApiKey: async () => ({ valid: true, userId: 'u_1' }),
      },
      {
        baseUrl: 'http://appliance.local:3030',
        me: async () => ({
          id: 'u_1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          avatarUrl: null,
        }),
      },
    );

    const env = { CI_CONFIG_DIR: tmpDir };

    await loginCommand(ctx, {}, env);

    expect(ctx.term.text()).toContain('Logged in to http://appliance.local:3030 as ada@example.com');
    const stored = readStoredCredentials(env);

    expect(stored).toMatchObject({
      serverUrl: 'http://appliance.local:3030',
      apiKey: 'ci_live_key_123456',
      userEmail: 'ada@example.com',
    });

    const mode = statSync(path.join(tmpDir, 'credentials.json')).mode & 0o777;

    expect(mode).toBe(0o600);
    expect(resolveTarget({}, env)).toEqual({
      baseUrl: 'http://appliance.local:3030',
      apiKey: 'ci_live_key_123456',
    });
  });

  it('authenticates with username + password via CSRF token, mints a CLI key, and persists it', async () => {
    const seen: unknown[] = [];
    const ctx = harness({
      baseUrl: 'http://appliance.local:3030',
      apiKey: null,
      getCsrfToken: async () => ({ csrfToken: 'csrf_tok_1' }),
      authenticate: async (body, csrf) => {
        seen.push({ step: 'authenticate', body, csrf });

        return { accessToken: 'jwt_access_1' };
      },
      createApiKey: async (body, bearer) => {
        seen.push({ step: 'createApiKey', body, bearer });

        return {
          id: 'key_99',
          name: body.name,
          key: 'ci_minted_secret_key',
          keyPrefix: 'ci_minted_s',
          capability: body.capability ?? 'full',
          scope: null,
          createdAt: '2026-11-12T00:00:00.000Z',
          expiresAt: null,
        };
      },
    });

    const env = { CI_CONFIG_DIR: tmpDir };

    await loginCommand(
      ctx,
      {
        username: 'ada@example.com',
        password: 'correct-horse-battery-staple',
        keyName: 'workstation',
        capability: 'full',
      },
      env,
    );

    expect(seen).toEqual([
      {
        step: 'authenticate',
        body: { username: 'ada@example.com', password: 'correct-horse-battery-staple' },
        csrf: 'csrf_tok_1',
      },
      {
        step: 'createApiKey',
        body: { name: 'workstation', capability: 'full' },
        bearer: 'jwt_access_1',
      },
    ]);
    expect(readStoredCredentials(env)?.apiKey).toBe('ci_minted_secret_key');
    expect(ctx.term.text()).toContain('Minted API key ci_minted_s…');
  });

  it('revokes the active key when --revoke is passed to logout and removes stored credentials', async () => {
    const env = { CI_CONFIG_DIR: tmpDir };
    let revokedCalled = false;

    const loginCtx = harness(
      {
        baseUrl: 'http://appliance.local:3030',
        apiKey: 'ci_live_key_123456',
        checkApiKey: async () => ({ valid: true }),
      },
      {
        baseUrl: 'http://appliance.local:3030',
        me: async () => null,
      },
    );

    await loginCommand(loginCtx, {}, env);
    expect(readStoredCredentials(env)).not.toBeNull();

    const logoutCtx = harness({
      baseUrl: 'http://appliance.local:3030',
      apiKey: 'ci_live_key_123456',
      revokeCurrentApiKey: async () => {
        revokedCalled = true;

        return { ok: true, revokedId: 'k_1' };
      },
    });

    await logoutCommand(logoutCtx, { revoke: true }, env);

    expect(revokedCalled).toBe(true);
    expect(readStoredCredentials(env)).toBeNull();
    expect(logoutCtx.term.text()).toContain('Revoked active API key');
  });

  it('prints the authenticated account in whoami and rejects when unauthenticated', async () => {
    const ctx = harness(
      {},
      {
        baseUrl: 'http://appliance.local:3030',
        me: async () => ({
          id: 'u_1',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          avatarUrl: null,
        }),
      },
    );

    await whoamiCommand(ctx);
    expect(ctx.term.text()).toContain('Ada Lovelace <ada@example.com>');
    expect(ctx.term.text()).toContain('http://appliance.local:3030');

    const unauthCtx = harness({}, { baseUrl: 'http://appliance.local:3030', me: async () => null });

    await expect(whoamiCommand(unauthCtx)).rejects.toBeInstanceOf(CliError);
  });
});
