import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { FeatureService } from '@ci/common/feature';
import { BodyParserMiddleware } from '@ci/common/middleware';

import { didKeyFromPublicKey, keyIdFromDidKey } from '../didKey';
import { LocalEd25519Signer, publicKeyFromSeed } from '../ed25519';
import { signRequest } from '../httpSignature';
import { PwsController } from '../PwsController';
import { formatCapabilityInvocation, rootZcapId } from '../zcap';

function createHttpIdentity(byte: number) {
  const seed = new Uint8Array(32).fill(byte);
  const did = didKeyFromPublicKey(publicKeyFromSeed(seed));
  const keyId = keyIdFromDidKey(did);

  return { did, keyId, signer: new LocalEd25519Signer(keyId, seed) };
}

describe('PwsController HTTP pipeline integration with BodyParserMiddleware (Digest & binary stream preservation)', () => {
  let app: INestApplication;
  let baseUrl = '';
  let pwsEnabled = false;

  @Module({
    controllers: [PwsController],
    providers: [
      {
        provide: FeatureService,
        useValue: { isFeatureEnabled: jest.fn(async () => pwsEnabled) },
      },
    ],
  })
  class PwsTestModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(BodyParserMiddleware).forRoutes('*');
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PwsTestModule],
    }).compile();

    app = moduleRef.createNestApplication({ bodyParser: false });
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/pws`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 404 on bare /pws and /pws/service when flag is disabled', async () => {
    pwsEnabled = false;
    expect((await fetch(`${baseUrl}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/service`)).status).toBe(404);
  });

  it('creates a space, collection, and preserves exact raw JSON + binary bytes over Digest: mh=...', async () => {
    pwsEnabled = true;
    const alice = createHttpIdentity(0x51);
    const created = Math.floor(Date.now() / 1000);

    async function signedFetch(args: {
      method: string;
      path: string;
      root?: string;
      body?: Uint8Array | string;
      contentType?: string;
    }) {
      const url = `${baseUrl}/${args.path}`;
      const rawBody =
        args.body === undefined
          ? undefined
          : typeof args.body === 'string'
            ? new TextEncoder().encode(args.body)
            : args.body;
      const headers: Record<string, string> = {};
      if (rawBody && args.contentType) {
        headers['content-type'] = args.contentType;
      }

      const signedHeaders = await signRequest({
        method: args.method,
        url,
        headers,
        ...(rawBody ? { body: rawBody } : {}),
        signer: alice.signer,
        created,
        capabilityInvocation: formatCapabilityInvocation({
          rootId: rootZcapId(args.root ?? url),
          action: args.method,
        }),
      });

      return fetch(url, {
        method: args.method,
        headers: signedHeaders,
        body: rawBody ? Buffer.from(rawBody) : undefined,
      });
    }

    const serviceRes = await fetch(`${baseUrl}/service`);
    expect(serviceRes.status).toBe(200);

    const spaceUrl = `${baseUrl}/space/s-http/`;
    const createSpaceRes = await signedFetch({
      method: 'POST',
      path: 'spaces/',
      body: JSON.stringify({ id: 's-http', name: 'HTTP Space', controller: alice.did }),
      contentType: 'application/json',
    });
    expect(createSpaceRes.status).toBe(201);

    const createCollectionRes = await signedFetch({
      method: 'POST',
      path: 'space/s-http/',
      root: spaceUrl,
      body: JSON.stringify({ id: 'notes', name: 'Notes' }),
      contentType: 'application/json',
    });
    expect(createCollectionRes.status).toBe(201);

    const nonCompactJson = '{\n  "greeting" :  "hello" ,\n  "count": 2\n}';
    const putJsonRes = await signedFetch({
      method: 'PUT',
      path: 'space/s-http/notes/note-1',
      root: spaceUrl,
      body: nonCompactJson,
      contentType: 'application/json',
    });
    expect(putJsonRes.status).toBe(204);

    const getJsonRes = await signedFetch({
      method: 'GET',
      path: 'space/s-http/notes/note-1',
      root: spaceUrl,
    });
    expect(getJsonRes.status).toBe(200);
    expect(await getJsonRes.text()).toBe(nonCompactJson);

    // Arbitrary binary payload works identically without JSON content-type assumptions
    const binaryBytes = Uint8Array.from([0x00, 0xff, 0x10, 0x42, 0x99]);
    const putBinRes = await signedFetch({
      method: 'PUT',
      path: 'space/s-http/notes/blob.bin',
      root: spaceUrl,
      body: binaryBytes,
      contentType: 'application/octet-stream',
    });
    expect(putBinRes.status).toBe(204);

    const getBinRes = await signedFetch({
      method: 'GET',
      path: 'space/s-http/notes/blob.bin',
      root: spaceUrl,
    });
    expect(getBinRes.status).toBe(200);
    expect(new Uint8Array(await getBinRes.arrayBuffer())).toEqual(binaryBytes);
  });
});
