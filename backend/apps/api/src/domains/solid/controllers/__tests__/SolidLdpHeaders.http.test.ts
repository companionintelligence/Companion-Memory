import { Test } from '@nestjs/testing';
import request from 'supertest';

import { ContextService } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { GraphQueryService } from '@ci/domains/memory';
import { UserService } from '@ci/domains/user';

import { ContainerService } from '../../services/ContainerService';
import { EntityProjectionService } from '../../services/EntityProjectionService';
import { ProfileDocumentService } from '../../services/ProfileDocumentService';
import { WebIdService } from '../../services/WebIdService';
import { StorageController } from '../StorageController';
import { WebIdController } from '../WebIdController';

async function createSolidTestApp(enabled: boolean) {
  const webIdService = new WebIdService();
  const profileDocuments = new ProfileDocumentService(webIdService);
  const projection = new EntityProjectionService(webIdService);
  const container = new ContainerService(webIdService);

  const moduleRef = await Test.createTestingModule({
    controllers: [WebIdController, StorageController],
    providers: [
      { provide: FeatureService, useValue: { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) } },
      {
        provide: UserService,
        useValue: {
          findById: jest.fn().mockResolvedValue({
            id: 'user-1',
            name: 'Alice',
            email: 'alice@example.org',
          }),
        },
      },
      {
        provide: GraphQueryService,
        useValue: {
          getNodes: jest.fn().mockResolvedValue([]),
          getNode: jest.fn().mockResolvedValue({
            entity_id: 'entity-1',
            name: 'Note One',
            entity_type: 'Thing',
            description: 'Stored memory node',
            created_at: new Date('2026-11-12T00:00:00Z'),
            updated_at: new Date('2026-11-12T00:00:00Z'),
            properties: {},
          }),
          getRelationships: jest.fn().mockResolvedValue([]),
        },
      },
      { provide: WebIdService, useValue: webIdService },
      { provide: ProfileDocumentService, useValue: profileDocuments },
      { provide: EntityProjectionService, useValue: projection },
      { provide: ContainerService, useValue: container },
    ],
  })
    .overrideGuard(JwtOrApiKeyAuthGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  app.use((req: { headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    const userHeader = req.headers['x-test-user'];
    ContextService.run(
      {
        traceId: 'solid-http-test',
        userId: typeof userHeader === 'string' ? userHeader : undefined,
      },
      next,
    );
  });
  await app.init();

  return app;
}

describe('Solid LDP discovery headers and fail-closed OPTIONS routes', () => {
  it('returns 404 on WebID and storage OPTIONS/GET routes when solid.protocol is disabled', async () => {
    const app = await createSolidTestApp(false);
    const server = app.getHttpServer();

    await request(server).options('/solid/profile/user-1').expect(404);
    await request(server).get('/solid/profile/user-1').expect(404);
    await request(server).options('/solid/storage/user-1/entity').set('x-test-user', 'user-1').expect(404);
    await request(server)
      .options('/solid/storage/user-1/entity/entity-1')
      .set('x-test-user', 'user-1')
      .expect(404);

    await app.close();
  });

  it('emits LDP Vary/Allow/Link/WAC-Allow headers on WebID and pod resources and stays owner-scoped', async () => {
    const app = await createSolidTestApp(true);
    const server = app.getHttpServer();

    const profileOpt = await request(server).options('/solid/profile/user-1').expect(204);
    expect(profileOpt.headers.vary).toBe('Accept');
    expect(profileOpt.headers.allow).toBe('GET, HEAD, OPTIONS');
    expect(profileOpt.headers.link).toBe('<http://www.w3.org/ns/ldp#Resource>; rel="type"');
    expect(profileOpt.headers['wac-allow']).toBe('public="read"');

    const profileGet = await request(server)
      .get('/solid/profile/user-1')
      .set('Accept', 'text/turtle')
      .expect(200);
    expect(profileGet.headers.vary).toBe('Accept');
    expect(profileGet.headers['wac-allow']).toBe('public="read"');
    expect(profileGet.text).toContain('Alice');

    const containerOpt = await request(server)
      .options('/solid/storage/user-1/entity')
      .set('x-test-user', 'user-1')
      .expect(204);
    expect(containerOpt.headers.link).toBe(
      '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type", <http://www.w3.org/ns/ldp#Resource>; rel="type"',
    );
    expect(containerOpt.headers['wac-allow']).toBe('user="read"');
    expect(containerOpt.headers.allow).toBe('GET, HEAD, OPTIONS');

    const containerGet = await request(server)
      .get('/solid/storage/user-1/entity')
      .set('x-test-user', 'user-1')
      .set('Accept', 'application/ld+json')
      .expect(200);
    expect(containerGet.headers.link).toContain('ldp#BasicContainer');
    expect(containerGet.headers['wac-allow']).toBe('user="read"');

    const entityOpt = await request(server)
      .options('/solid/storage/user-1/entity/entity-1')
      .set('x-test-user', 'user-1')
      .expect(204);
    expect(entityOpt.headers.link).toBe(
      '<http://www.w3.org/ns/ldp#RDFSource>; rel="type", <http://www.w3.org/ns/ldp#Resource>; rel="type"',
    );
    expect(entityOpt.headers['wac-allow']).toBe('user="read"');

    const entityGet = await request(server)
      .get('/solid/storage/user-1/entity/entity-1')
      .set('x-test-user', 'user-1')
      .set('Accept', 'text/turtle')
      .expect(200);
    expect(entityGet.headers.vary).toBe('Accept');
    expect(entityGet.headers.link).toContain('ldp#RDFSource');
    expect(entityGet.headers['wac-allow']).toBe('user="read"');
    expect(entityGet.text).toContain('Note One');

    // Cross-user OPTIONS fails closed with 404 (WAC-lite owner isolation)
    await request(server).options('/solid/storage/user-2/entity').set('x-test-user', 'user-1').expect(404);

    await app.close();
  });
});
