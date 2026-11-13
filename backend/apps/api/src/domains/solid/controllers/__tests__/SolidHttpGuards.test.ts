import {
  type ExecutionContext,
  type INestApplication,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  UnauthorizedException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ContextService, RequestContextMiddleware } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { IdFormatGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import config from '@ci/configuration';
import { GraphQueryService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

import { SolidProtocolGuard } from '../../guards/SolidProtocolGuard';
import { ContainerService } from '../../services/ContainerService';
import { EntityProjectionService } from '../../services/EntityProjectionService';
import { WebIdService } from '../../services/WebIdService';
import { StorageController } from '../StorageController';

const OWNER_ID = '0190bd3e-0000-7000-8000-000000000001';
const OTHER_USER_ID = '0190bd3e-0000-7000-8000-000000000099';
const ENTITY_ID = '0190bd3e-0000-7000-8000-000000000002';

describe('Solid StorageController HTTP guard ordering (SolidProtocolGuard + JwtOrApiKeyAuthGuard)', () => {
  let app: INestApplication;
  let solidEnabled = false;
  const jwtService = new JwtService({});

  const mockGraphQuery = {
    getNode: jest.fn().mockResolvedValue(null),
    getNodes: jest.fn().mockResolvedValue([]),
    getRelationships: jest.fn().mockResolvedValue([]),
  };

  const mockUserService = {
    findById: jest.fn(async (_ctx: unknown, id: string) => {
      if (id === OWNER_ID) {
        return { id: OWNER_ID, name: 'Alice', email: 'alice@example.com' };
      }

      if (id === OTHER_USER_ID) {
        return { id: OTHER_USER_ID, name: 'Bob', email: 'bob@example.com' };
      }

      return null;
    }),
  };

  @Module({
    controllers: [StorageController],
    providers: [
      { provide: APP_GUARD, useClass: IdFormatGuard },
      SolidProtocolGuard,
      {
        provide: FeatureService,
        useValue: { isFeatureEnabled: jest.fn(async () => solidEnabled) },
      },
      { provide: GraphQueryService, useValue: mockGraphQuery },
      WebIdService,
      EntityProjectionService,
      ContainerService,
      {
        provide: UserService,
        useValue: mockUserService,
      },
    ],
  })
  class SolidTestModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(RequestContextMiddleware).forRoutes('*');
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SolidTestModule],
    })
      .overrideGuard(JwtOrApiKeyAuthGuard)
      .useValue({
        canActivate: async (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<{
            headers: { authorization?: string };
            user?: { id: string; userId: string };
          }>();
          const authHeader = req.headers.authorization;
          if (!authHeader?.startsWith('Bearer ')) {
            throw new UnauthorizedException();
          }

          try {
            const payload = await jwtService.verifyAsync<{ sub: string }>(
              authHeader.slice('Bearer '.length),
              {
                secret: config.auth.jwt.authTokenSecret,
              },
            );
            const user = await mockUserService.findById(null, payload.sub);
            if (!user) {
              throw new UnauthorizedException();
            }

            ContextService.set({ userId: user.id });
            req.user = { id: user.id, userId: user.id };

            return true;
          } catch {
            throw new UnauthorizedException();
          }
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    solidEnabled = false;
    jest.clearAllMocks();
  });

  function bearerFor(userId: string): string {
    return jwtService.sign({ sub: userId }, { secret: config.auth.jwt.authTokenSecret, expiresIn: '15m' });
  }

  it('registers SolidProtocolGuard before JwtOrApiKeyAuthGuard on StorageController', () => {
    const classGuards = Reflect.getMetadata(GUARDS_METADATA, StorageController) as unknown[];
    expect(classGuards.slice(0, 2)).toEqual([SolidProtocolGuard, JwtOrApiKeyAuthGuard]);
  });

  it('returns 404 (not 401) for unauthenticated pod requests when solid.protocol is disabled', async () => {
    solidEnabled = false;

    await request(app.getHttpServer()).get(`/solid/storage/${OWNER_ID}/entity/`).expect(404);
    await request(app.getHttpServer()).get(`/solid/storage/${OWNER_ID}/entity/${ENTITY_ID}`).expect(404);
  });

  it('returns 401 when solid.protocol is enabled and no credentials are supplied', async () => {
    solidEnabled = true;

    await request(app.getHttpServer()).get(`/solid/storage/${OWNER_ID}/entity/`).expect(401);
    await request(app.getHttpServer()).get(`/solid/storage/${OWNER_ID}/entity/${ENTITY_ID}`).expect(401);
  });

  it('allows owner JWT to read their container as Turtle and returns 404 to another authenticated user', async () => {
    solidEnabled = true;

    const ownerRes = await request(app.getHttpServer())
      .get(`/solid/storage/${OWNER_ID}/entity/`)
      .set('Authorization', `Bearer ${bearerFor(OWNER_ID)}`)
      .expect(200);

    expect(ownerRes.headers['content-type']).toContain('text/turtle');
    expect(ownerRes.text).toContain('ldp:BasicContainer');

    await request(app.getHttpServer())
      .get(`/solid/storage/${OWNER_ID}/entity/`)
      .set('Authorization', `Bearer ${bearerFor(OTHER_USER_ID)}`)
      .expect(404);
  });
});
