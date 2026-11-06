/**
 * Runs the Portable Web Spaces handler on a local port over an in-memory store, so a PWS client or
 * the conformance suite can be pointed at it. A development tool: nothing in `src` imports it, it
 * keeps no data past the process, and it is not how PWS would ship (see `docs/pws.md`).
 *
 *   yarn workspace @ci/be-api node -r @swc/register scripts/pws-dev-server.ts [port]
 *
 * It listens on 127.0.0.1 only (`PWS_HOST` overrides): the handler lets any caller create a Space with a
 * self-made `did:key`, and the store is RAM with no quota, so it must not be reachable from the network by
 * accident.
 *
 * The URL the suite is given must be byte-identical to `PWS_BASE_URL` (default
 * `http://localhost:<port>/`): capabilities embed their target and the server compares it as a string,
 * so `localhost` and `127.0.0.1` are different servers.
 */
import { createServer } from 'node:http';

import { MemoryPwsStore, createPwsHandler, nodeListener } from '../src/domains/pws';

const port = Number(process.env.PORT ?? process.argv[2] ?? 3002);
const host = process.env.PWS_HOST ?? '127.0.0.1';
const baseUrl = process.env.PWS_BASE_URL ?? `http://localhost:${port}/`;
const maxUploadBytes = Number(process.env.PWS_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);

const handler = createPwsHandler({
  baseUrl,
  store: new MemoryPwsStore(),
  maxUploadBytes,
  instance: { name: 'companion-memory-pws-dev', version: '0' },
  onError: (error) => console.error('[pws] unexpected error', error),
});

createServer(nodeListener(handler, { maxBodyBytes: maxUploadBytes + 1024 })).listen(port, host, () => {
  console.log(`[pws] serving ${baseUrl} (in-memory, listening on ${host}:${port})`);
});
