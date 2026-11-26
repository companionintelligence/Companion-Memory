import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { READ_CAPABILITY, REQUIRE_CAPABILITY_KEY } from '@ci/common/decorators';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { FileService } from '@ci/domains/files';
import { OllamaService } from '@ci/domains/llm';

import { HealthController } from '../HealthController';

describe('authenticated operation readiness', () => {
  const originalFetch = globalThis.fetch;
  const originalStatusPath = process.env.CI_BACKUP_STATUS_FILE;
  let directory: string;
  let query: jest.Mock;
  let controller: HealthController;
  let isAdmin: boolean;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-health-'));
    process.env.CI_BACKUP_STATUS_FILE = join(directory, 'backup.json');
    isAdmin = false;
    query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM pgboss.job')) {
        return [{ waiting: 2, active: 1, failed: 3, delayed: 1 }];
      }

      if (sql.includes('FROM ci.connections')) {
        return [{ connected: 2, needsSignIn: 1, syncing: 1, isAdmin }];
      }

      return [{ '?column?': 1 }];
    });
    globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({ status: 'ok' }))) as typeof fetch;
    controller = new HealthController(
      { query } as unknown as DataSource,
      { checkChatModel: async () => ({ reachable: true, available: true }) } as unknown as OllamaService,
      { checkStorage: async () => {} } as unknown as FileService,
      { isFeatureEnabled: async () => true } as unknown as FeatureService,
    );
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalStatusPath === undefined) {
      delete process.env.CI_BACKUP_STATUS_FILE;
    } else {
      process.env.CI_BACKUP_STATUS_FILE = originalStatusPath;
    }

    await rm(directory, { recursive: true, force: true });
  });

  it('requires an account and scopes job and connection counts to it', async () => {
    await expect(controller.operations({})).rejects.toBeInstanceOf(UnauthorizedException);
    const status = await controller.operations({ userId: 'owner' });
    expect(
      query.mock.calls.filter(([sql]) => sql !== 'SELECT 1').every(([, args]) => args[0] === 'owner'),
    ).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.processing).toMatchObject({ waiting: 2, active: 1, failed: 3, delayed: 1, ok: false });
    expect(status.dependencies).toContainEqual(expect.objectContaining({ name: 'connections', ok: false }));
    expect(status.backup).toBeNull();
  });

  it('shows administrators a bounded backup summary without paths or errors', async () => {
    isAdmin = true;
    const date = new Date().toISOString();
    await writeFile(
      process.env.CI_BACKUP_STATUS_FILE!,
      JSON.stringify({
        state: 'complete',
        last_success_at: date,
        bytes: 123,
        coverage: 'database, uploaded files and secrets',
        snapshot: '/private/snapshots',
        error: 'private driver failure',
      }),
    );
    const status = await controller.operations({ userId: 'owner' });
    expect(status.backup).toEqual({
      state: 'complete',
      lastSuccessAt: date,
      bytes: 123,
      coverage: 'database, uploaded files and secrets',
    });
    expect(JSON.stringify(status)).not.toMatch(/private/);
  });

  it('reports stale or unreadable backups without losing other component results', async () => {
    isAdmin = true;
    await writeFile(
      process.env.CI_BACKUP_STATUS_FILE!,
      JSON.stringify({ state: 'complete', last_success_at: '2020-01-01T00:00:00Z' }),
    );
    expect((await controller.operations({ userId: 'owner' })).backup?.state).toBe('overdue');
    await writeFile(process.env.CI_BACKUP_STATUS_FILE!, '{incomplete');
    const status = await controller.operations({ userId: 'owner' });
    expect(status.backup).toEqual({ state: 'unavailable' });
    expect(status.dependencies).toContainEqual(expect.objectContaining({ name: 'files', ok: true }));
  });

  it('says a backup is not configured when no status file is named, and failed when the file says so', async () => {
    isAdmin = true;
    delete process.env.CI_BACKUP_STATUS_FILE;
    expect((await controller.operations({ userId: 'owner' })).backup).toEqual({ state: 'not_configured' });

    process.env.CI_BACKUP_STATUS_FILE = join(directory, 'backup.json');
    await writeFile(
      process.env.CI_BACKUP_STATUS_FILE,
      JSON.stringify({ state: 'failed', last_success_at: new Date().toISOString() }),
    );
    expect((await controller.operations({ userId: 'owner' })).backup?.state).toBe('failed');
  });

  it('contains sidecar failures and keeps private transport details out of the response', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('secret-internal-host:8002');
    }) as typeof fetch;
    const status = await controller.operations({ userId: 'owner' });
    expect(
      status.dependencies
        .filter((part) => ['summaries', 'documents', 'predictions'].includes(part.name))
        .every((part) => !part.ok),
    ).toBe(true);
    expect(JSON.stringify(status)).not.toContain('secret-internal-host');
  });

  // The liveness and deep checks stay open for monitors; this is the one route that is an account's own.
  it('is the one route that needs a sign-in, and asks only for read access', () => {
    const route = (name: 'check' | 'detailed' | 'operations') => HealthController.prototype[name] as object;
    const guards = (name: 'check' | 'detailed' | 'operations') =>
      (Reflect.getMetadata('__guards__', route(name)) as unknown[] | undefined) ?? [];

    expect(guards('operations')).toContain(JwtOrApiKeyAuthGuard);
    expect(Reflect.getMetadata(REQUIRE_CAPABILITY_KEY, route('operations'))).toBe(READ_CAPABILITY);
    expect(guards('check')).toEqual([]);
    expect(guards('detailed')).toEqual([]);
  });

  // "Delayed" is late against a job's own schedule, not its age. The first version compared the
  // creation time, so a job made long before its start time was flagged the moment it became due.
  // A database is needed to run the statement, so this pins the two rules in its text.
  it('counts a job as delayed by its schedule, not by when it was created', async () => {
    await controller.operations({ userId: 'owner' });
    const statement = query.mock.calls
      .map(([sql]) => String(sql).replace(/\s+/g, ' '))
      .find((sql) => sql.includes('FROM pgboss.job'));

    expect(statement).toContain("(state = 'created' AND start_after < now() - interval '15 minutes')");
    expect(statement).toContain("(state = 'active' AND started_on < now() - interval '2 hours')");
    expect(statement).not.toContain('created_on');
  });

  it('answers with what it could not check instead of failing when nothing is wired', async () => {
    const status = await new HealthController().operations({ userId: 'owner' });

    expect(status.ok).toBe(false);
    expect(status.syncEnabled).toBe(false);
    expect(status.backup).toBeNull();
    expect(status.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'files', ok: false, detail: 'not configured' }),
        expect.objectContaining({ name: 'processing', ok: false, detail: 'not configured' }),
      ]),
    );
  });

  // Both services are @Optional(), so a provider Nest cannot match would not fail anything: the
  // controller would just report "not configured" forever. This builds it through Nest's container.
  it('is given the storage and feature services by Nest, which is what makes them real', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: getDataSourceToken(), useValue: { query } },
        {
          provide: OllamaService,
          useValue: { checkChatModel: async () => ({ reachable: true, available: true }) },
        },
        { provide: FileService, useValue: { checkStorage: async () => {} } },
        { provide: FeatureService, useValue: { isFeatureEnabled: async () => true } },
      ],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    const status = await moduleRef.get(HealthController).operations({ userId: 'owner' });
    await moduleRef.close();

    expect(status.syncEnabled).toBe(true);
    expect(status.dependencies).toContainEqual(expect.objectContaining({ name: 'files', ok: true }));
  });
});
