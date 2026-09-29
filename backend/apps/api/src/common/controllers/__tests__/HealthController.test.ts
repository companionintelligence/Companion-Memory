import { type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';

import { OllamaService } from '@ci/domains/llm';

import { HealthController } from '../HealthController';

const dataSource = { query: jest.fn() };
// `checkChatModel`, not `preflightChatModel`: the deep route must call the
// silent check, because the preflight logs on every path and overwrites the
// service's cached boot-time state.
const ollama = { checkChatModel: jest.fn(), preflightChatModel: jest.fn() };

@Module({
  controllers: [HealthController],
  providers: [
    { provide: getDataSourceToken(), useValue: dataSource },
    { provide: OllamaService, useValue: ollama },
  ],
})
class HealthTestModule {}

/** No providers at all — the shape the `@Optional()` injections exist to survive. */
@Module({
  controllers: [HealthController],
})
class BareHealthTestModule {}

describe('HealthController', () => {
  let app: INestApplication;

  // Per test, not per file: the controller memoizes `/health/detailed` for a
  // few seconds, so a shared instance would serve the first case's body to
  // every case after it.
  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HealthTestModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    jest.clearAllMocks();

    dataSource.query.mockResolvedValue([{ '?column?': 1 }]);
    ollama.checkChatModel.mockResolvedValue({
      model: 'qwen3:4b',
      available: true,
      reachable: true,
      servedModels: ['qwen3:4b'],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /health', () => {
    it('returns 200 with { status: "ok" }', async () => {
      const res = await request(app.getHttpServer()).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok' });
    });

    // Capture clients (browser extension, applet, importer) authenticate ONLY
    // with a portal token, so when portal auth is off every one of their
    // requests 401s and the guard cannot say why — a rejected token is
    // indistinguishable from an absent one. Publishing the flag here is what
    // lets a client tell "my token is bad" apart from "this server does not
    // accept portal tokens at all".
    it('publishes whether the server accepts portal OIDC tokens', async () => {
      const res = await request(app.getHttpServer()).get('/health');

      expect(typeof res.body.portalAuthEnabled).toBe('boolean');
    });

    it('advertises the API contract so an older app or server can say which side to update', async () => {
      const res = await request(app.getHttpServer()).get('/health');

      expect(res.body.apiVersion).toBe(1);
      expect(res.body.minClientVersion).toBe(1);
    });

    it('responds to repeated calls (liveness probe semantics)', async () => {
      // Sequential, not Promise.all: parallel supertest requests each spin up a
      // fresh ephemeral listener on the same un-listened server and race to bind,
      // which flakes in CI. A liveness probe only needs to stay 200 across calls.
      for (let i = 0; i < 5; i++) {
        const res = await request(app.getHttpServer()).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
      }
    });

    it('does not require authentication', async () => {
      // Health check is intentionally unauthenticated so CI-Gateway and external
      // probes (Companion Hub, container orchestrators) can reach it without
      // managing credentials. If this test starts failing, the gateway and
      // operational monitoring will silently stop reporting Server health.
      const res = await request(app.getHttpServer())
        .get('/health')
        // explicitly no auth header / cookie
        .set('Authorization', '');

      expect(res.status).toBe(200);
    });

    it('stays a static 200 while dependencies are down, and probes nothing', async () => {
      // The liveness contract: restarting the container does not revive a dead
      // Postgres, so this route must not start failing when one is. The deep
      // check lives at /health/detailed precisely so this one can stay dumb.
      dataSource.query.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

      const res = await request(app.getHttpServer()).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'ok',
        portalAuthEnabled: expect.any(Boolean),
        apiVersion: 1,
        minClientVersion: 1,
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('GET /health/detailed', () => {
    it('reports every dependency ok when they all answer', async () => {
      const res = await request(app.getHttpServer()).get('/health/detailed');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies).toEqual([
        // latencyMs is measured at runtime; asserting only its type keeps this
        // test off the clock.
        { name: 'postgres', ok: true, latencyMs: expect.any(Number) },
        { name: 'llm', ok: true, latencyMs: expect.any(Number) },
      ]);
      expect(dataSource.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('stays 200 and names the dependency that is down', async () => {
      dataSource.query.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

      const res = await request(app.getHttpServer()).get('/health/detailed');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe('degraded');

      const postgres = res.body.dependencies.find(
        (dependency: { name: string }) => dependency.name === 'postgres',
      );
      const llm = res.body.dependencies.find((dependency: { name: string }) => dependency.name === 'llm');

      expect(postgres.ok).toBe(false);
      expect(postgres.detail).toMatch(/probe failed/);
      // One dead dependency must not be reported as everything being dead.
      expect(llm.ok).toBe(true);
    });

    it('does not echo the driver error into the response body', async () => {
      // Driver messages carry hosts, ports and occasionally credentials, and
      // this route is unauthenticated.
      dataSource.query.mockRejectedValue(new Error('password authentication failed for user "ci"'));

      const res = await request(app.getHttpServer()).get('/health/detailed');

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('password');
    });

    it('separates an unreachable inference backend from a missing model', async () => {
      ollama.checkChatModel.mockResolvedValue({
        model: 'qwen3:4b',
        available: false,
        reachable: false,
        servedModels: [],
        reason: 'fetch failed',
      });

      const res = await request(app.getHttpServer()).get('/health/detailed');

      expect(res.body.ok).toBe(false);
      expect(res.body.dependencies).toContainEqual({
        name: 'llm',
        ok: false,
        detail: 'inference backend did not answer',
        latencyMs: expect.any(Number),
      });
    });

    it('reports a reachable backend that does not serve the configured model', async () => {
      ollama.checkChatModel.mockResolvedValue({
        model: 'qwen/qwen3-vl-30b',
        available: false,
        reachable: true,
        servedModels: ['qwen3-vl:4b'],
        suggestions: ['qwen3-vl:4b'],
      });

      const res = await request(app.getHttpServer()).get('/health/detailed');

      expect(res.body.ok).toBe(false);

      const llm = res.body.dependencies.find((dependency: { name: string }) => dependency.name === 'llm');

      expect(llm).toMatchObject({ ok: false, detail: 'configured chat model is not served' });
      // The configured id is operator configuration, not something an
      // unauthenticated caller gets to read back.
      expect(JSON.stringify(res.body)).not.toContain('qwen');
    });

    it('contains a probe that throws synchronously', async () => {
      ollama.checkChatModel.mockImplementation(() => {
        throw new TypeError('client is not a function');
      });

      const res = await request(app.getHttpServer()).get('/health/detailed');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);

      const llm = res.body.dependencies.find((dependency: { name: string }) => dependency.name === 'llm');
      const postgres = res.body.dependencies.find(
        (dependency: { name: string }) => dependency.name === 'postgres',
      );

      expect(llm).toMatchObject({ ok: false, detail: 'probe failed (TypeError)' });
      expect(postgres.ok).toBe(true);
    });

    it('never runs the boot-time preflight', async () => {
      // `preflightChatModel` writes a log line on EVERY path and overwrites the
      // service's cached preflight state. This route is unauthenticated, so
      // calling it here would let anyone that can reach the port fill the log
      // and churn state the rest of the app reads.
      await request(app.getHttpServer()).get('/health/detailed');

      expect(ollama.checkChatModel).toHaveBeenCalled();
      expect(ollama.preflightChatModel).not.toHaveBeenCalled();
    });

    it('gives the LLM check a budget inside the shared probe timeout', async () => {
      // The service's own default is 5s against the controller's 2s, so without
      // an explicit budget the check could only ever be reported as the generic
      // controller timeout instead of "inference backend did not answer".
      await request(app.getHttpServer()).get('/health/detailed');

      const [budgetMs] = ollama.checkChatModel.mock.calls[0] as [number];

      expect(budgetMs).toBeLessThan(2_000);
    });

    it('reuses one probe round across a burst of callers', async () => {
      // Unauthenticated route: without this, each anonymous request costs a
      // connection out of the pg pool plus an outbound call to the inference
      // backend.
      const first = await request(app.getHttpServer()).get('/health/detailed');
      const second = await request(app.getHttpServer()).get('/health/detailed');

      expect(second.body).toEqual(first.body);
      expect(dataSource.query).toHaveBeenCalledTimes(1);
      expect(ollama.checkChatModel).toHaveBeenCalledTimes(1);
    });
  });

  describe('with nothing wired', () => {
    let bareApp: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BareHealthTestModule],
      }).compile();

      bareApp = moduleRef.createNestApplication();
      await bareApp.init();
    });

    afterAll(async () => {
      await bareApp.close();
    });

    it('still serves liveness, and reports the unwired dependencies', async () => {
      const liveness = await request(bareApp.getHttpServer()).get('/health');

      expect(liveness.status).toBe(200);
      expect(liveness.body.status).toBe('ok');

      const detailed = await request(bareApp.getHttpServer()).get('/health/detailed');

      expect(detailed.status).toBe(200);
      expect(detailed.body.ok).toBe(false);
      expect(detailed.body.dependencies).toEqual([
        { name: 'postgres', ok: false, detail: 'not configured', latencyMs: expect.any(Number) },
        { name: 'llm', ok: false, detail: 'not configured', latencyMs: expect.any(Number) },
      ]);
    });
  });
});
