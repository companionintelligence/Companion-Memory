const mockPowersync = {
  url: 'https://ps.test',
  jwtSecret: 'shh-secret',
  audience: 'powersync',
  tokenTtl: '300s',
  jwtKid: 'ci-powersync-hs256',
};

jest.mock('@ci/configuration', () => {
  const actual = jest.requireActual('@ci/configuration').default;

  return {
    __esModule: true,
    default: {
      ...actual,
      get powersync() {
        return mockPowersync;
      },
    },
  };
});

import {
  Catch,
  Global,
  Module,
  UnauthorizedException,
  type ArgumentsHost,
  type INestApplication,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggingModule } from '@ci/common/logging';

import { PowerSyncModule } from '..';
import { POWERSYNC_NOT_CONFIGURED } from '../services/PowerSyncTokenService';

/**
 * Stands in for GlobalExceptionsFilter, which logs every 5xx at error level and
 * reports it to Sentry. Anything that reaches it here would reach that in the app.
 */
const caughtExceptions: unknown[] = [];

@Catch()
class RecordingExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    caughtExceptions.push(exception);
    super.catch(exception, host);
  }
}

/**
 * PowerSyncModule provides SyncWindowSweepCron, which injects the app
 * DataSource. `TypeOrmModule.forRoot` makes that global in the running app, but
 * a module compiled in isolation has no such ambient provider — and a provider
 * declared on the testing module's own root is not visible inside an imported
 * module, so it has to arrive as a @Global module of its own.
 *
 * These are route tests with no database behind them; the sweep's behaviour is
 * covered by SyncWindowSweepCron.test.ts.
 */
@Global()
@Module({
  providers: [
    { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([{ count: '0' }]) } },
  ],
  exports: [getDataSourceToken()],
})
class StubDataSourceModule {}

// Regression coverage for the JwtAuthGuard -> JwtOrApiKeyAuthGuard swap on
// PowerSyncController: overriding JwtOrApiKeyAuthGuard here only takes effect if
// the controller actually declares that guard. If it still used the old
// JwtAuthGuard, this override would be a no-op and the "valid credentials" case
// would fail against the real (unmocked) guard.
const mockCanActivate = jest.fn();

class MockJwtOrApiKeyAuthGuard {
  canActivate = mockCanActivate;
}

describe('PowerSync routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    mockCanActivate.mockImplementation(() => true);

    const module = await Test.createTestingModule({
      imports: [StubDataSourceModule, PowerSyncModule, LoggingModule],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useClass(MockJwtOrApiKeyAuthGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalFilters(new RecordingExceptionFilter(app.getHttpAdapter()));

    app.use((req: Request, res: Response, next: NextFunction) => {
      ContextService.run({ traceId: 'test-trace-id', userId: 'test-user-id' }, () => {
        next();
      });
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('with valid auth credentials (JWT or API key)', () => {
    beforeEach(() => {
      mockCanActivate.mockImplementation(() => true);
    });

    it('should return a 200 with PowerSync credentials for GET /powersync/token', () => {
      return request(app.getHttpServer())
        .get('/powersync/token')
        .expect(200)
        .expect(({ body }) => {
          expect(typeof body.token).toBe('string');
          expect(body.powersync_url).toBe('https://ps.test');
        });
    });
  });

  describe('when this deployment runs no PowerSync service', () => {
    beforeEach(() => {
      mockCanActivate.mockImplementation(() => true);
      mockPowersync.url = '';
      mockPowersync.jwtSecret = '';
      caughtExceptions.length = 0;
    });

    afterEach(() => {
      mockPowersync.url = 'https://ps.test';
      mockPowersync.jwtSecret = 'shh-secret';
    });

    it('answers 503 with a stable code clients can stop on', () => {
      return request(app.getHttpServer())
        .get('/powersync/token')
        .expect(503)
        .expect(({ body }) => {
          expect(body).toEqual({
            statusCode: 503,
            error: 'Service Unavailable',
            message: 'PowerSync is not configured',
            code: POWERSYNC_NOT_CONFIGURED,
          });
        });
    });

    it('does not raise an exception, so it never lands in the error log or Sentry', async () => {
      await request(app.getHttpServer()).get('/powersync/token').expect(503);

      expect(caughtExceptions).toEqual([]);
    });

    it('still requires auth before saying anything about the deployment', () => {
      mockCanActivate.mockImplementation(() => {
        throw new UnauthorizedException();
      });

      return request(app.getHttpServer()).get('/powersync/token').expect(401);
    });
  });

  describe('without valid auth credentials', () => {
    beforeEach(() => {
      mockCanActivate.mockImplementation(() => {
        throw new UnauthorizedException();
      });
    });

    it('should return a 401 for GET /powersync/token', () => {
      return request(app.getHttpServer()).get('/powersync/token').expect(401);
    });
  });
});
