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

import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { LoggingModule } from '@ci/common/logging';

import { PowerSyncModule } from '..';

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
      imports: [PowerSyncModule, LoggingModule],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useClass(MockJwtOrApiKeyAuthGuard)
      .compile();

    app = module.createNestApplication();

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
