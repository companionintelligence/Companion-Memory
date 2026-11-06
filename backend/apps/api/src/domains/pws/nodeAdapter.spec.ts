import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { alice } from './__tests__/testKit';
import { createPwsHandler } from './handler';
import { signRequest } from './httpSignature';
import { nodeListener } from './nodeAdapter';
import { MemoryPwsStore } from './store';
import { formatCapabilityInvocation, rootZcapId } from './zcap';

/** A real PWS server on a real socket, and a client that signs the way the profile says. */
async function serve(
  maxBodyBytes = 1024 * 1024,
): Promise<{ origin: string; close(): Promise<void>; call: Call }> {
  let handler!: ReturnType<typeof createPwsHandler>;
  const server: Server = createServer((req, res) => nodeListener(handler, { maxBodyBytes })(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  handler = createPwsHandler({
    baseUrl: `${origin}/`,
    store: new MemoryPwsStore(),
    maxUploadBytes: maxBodyBytes,
  });

  const call: Call = async ({ method, path, json, body, contentType, signed = true, root }) => {
    const url = `${origin}${path}`;
    const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body;
    const type = contentType ?? (json !== undefined ? 'application/json' : 'application/octet-stream');
    const headers = signed
      ? await signRequest({
          method,
          url,
          headers: payload ? { 'content-type': type } : {},
          ...(payload ? { body: payload } : {}),
          signer: alice.signer,
          created: Math.floor(Date.now() / 1000),
          capabilityInvocation: formatCapabilityInvocation({
            rootId: rootZcapId(root ?? url),
            action: method,
          }),
        })
      : { ...(payload ? { 'content-type': type } : {}) };
    return new Promise((resolve, reject) => {
      const req = request(url, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', reject);
      req.end(payload);
    });
  };
  return { origin, call, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
type Call = (args: {
  method: string;
  path: string;
  json?: unknown;
  body?: Buffer;
  contentType?: string;
  signed?: boolean;
  root?: string;
}) => Promise<Reply>;

describe('the node:http binding', () => {
  let server: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    server = await serve();
  });
  afterAll(async () => {
    await server.close();
  });

  it('serves a whole round trip over a socket: create, write, read, head, delete', async () => {
    const { call, origin } = server;
    const created = await call({
      method: 'POST',
      path: '/spaces/',
      json: { id: 's', controller: alice.did },
    });
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(`${origin}/space/s/`);

    const space = `${origin}/space/s/`;
    expect(
      (await call({ method: 'POST', path: '/space/s/', root: space, json: { id: 'files' } })).status,
    ).toBe(201);

    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const put = await call({
      method: 'PUT',
      path: '/space/s/files/blob.bin',
      root: space,
      body: bytes,
      contentType: 'application/octet-stream',
    });
    expect(put.status).toBe(204);

    const get = await call({ method: 'GET', path: '/space/s/files/blob.bin', root: space });
    expect(get.status).toBe(200);
    expect(get.body.equals(bytes)).toBe(true);
    expect(get.headers['content-type']).toBe('application/octet-stream');
    expect(get.headers['content-length']).toBe('10');
    expect(get.headers.link).toBe(`<${origin}/service>; rel="service"`);

    const head = await call({ method: 'HEAD', path: '/space/s/files/blob.bin', root: space });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe('10');
    expect(head.body.length).toBe(0);

    expect((await call({ method: 'DELETE', path: '/space/s/files/blob.bin', root: space })).status).toBe(204);
    expect((await call({ method: 'GET', path: '/space/s/files/blob.bin', root: space })).status).toBe(404);
  });

  it('serves the unauthenticated parts to an unsigned client', async () => {
    const { call, origin } = server;
    const service = await call({ method: 'GET', path: '/service', signed: false });
    expect(service.status).toBe(200);
    expect(JSON.parse(service.body.toString()).url).toBe(`${origin}/service`);
    expect((await call({ method: 'GET', path: '/space/s/files/blob.bin', signed: false })).status).toBe(404);
  });

  it('takes the origin from its configuration, not from the Host header', async () => {
    const { call } = server;
    const reply = await new Promise<Reply>((resolve, reject) => {
      const url = new URL(`${server.origin}/spaces/`);
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: '/spaces/',
          method: 'GET',
          headers: { host: 'evil.example' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(reply.status).toBe(200); // an unsigned list is an empty list; the Host header changed nothing about routing
    expect(JSON.parse(reply.body.toString()).items).toEqual([]);
    expect(call).toBeDefined();
  });

  it('refuses a body over its limit with a problem, without reading it all', async () => {
    const small = await serve(256);
    try {
      const space = `${small.origin}/space/s/`;
      await small.call({ method: 'POST', path: '/spaces/', json: { id: 's', controller: alice.did } });
      await small.call({ method: 'POST', path: '/space/s/', root: space, json: { id: 'files' } });
      const big = await small
        .call({
          method: 'PUT',
          path: '/space/s/files/big',
          root: space,
          body: Buffer.alloc(4096),
          contentType: 'application/octet-stream',
        })
        .catch((error: NodeJS.ErrnoException) => error);
      if (big instanceof Error) {
        // the server closed the connection while the client was still sending: also a refusal
        expect(['ECONNRESET', 'EPIPE']).toContain(big.code);
      } else {
        expect(big.status).toBe(413);
        expect(JSON.parse(big.body.toString()).type).toBe('https://w3id.org/pws#payload-too-large');
        // the transport's own refusal carries what every other response carries
        expect(big.headers.link).toBe(`<${small.origin}/service>; rel="service"`);
        expect(big.headers['x-content-type-options']).toBe('nosniff');
        expect(big.headers['access-control-allow-origin']).toBe('*');
      }
    } finally {
      await small.close();
    }
  });
});
