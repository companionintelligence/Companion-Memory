import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOvermindEnv } from './overmind-env';
import { allocPort, DEFAULTS, type PublishedPorts, type StackPorts } from './ports';

/** What `docker ps` shows a worktree started beside another stack: the
 * sibling's object store already publishes the conventional port. */
const SIBLING_ON_9000: PublishedPorts = { own: new Set(), foreign: new Set([DEFAULTS.objectStore]) };

/** The ports a stack gets on an otherwise idle machine. */
const SOLO: StackPorts = {
  apiPort: DEFAULTS.api,
  webPort: DEFAULTS.web,
  dbPort: DEFAULTS.db,
  objPort: DEFAULTS.objectStore,
  hbpePort: DEFAULTS.hbpe,
  summaryPort: DEFAULTS.summary,
  parserPort: DEFAULTS.parser,
};

const STACK = { host: 'ci-server-feat-x.localhost', socket: '.overmind.sock' };

test('beside a stack holding 9000, vite proxies /static to the object store this stack was allocated', async () => {
  const objPort = await allocPort(DEFAULTS.objectStore, SIBLING_ON_9000);
  assert.notEqual(objPort, DEFAULTS.objectStore);

  const env = buildOvermindEnv({}, { ...SOLO, objPort }, STACK);

  assert.equal(env.STATIC_PROXY_TARGET, `http://127.0.0.1:${objPort}`);
});

test('vite reads media from the same object store the api writes it to', () => {
  const env = buildOvermindEnv({}, { ...SOLO, objPort: 58800 }, STACK);

  assert.equal(new URL(env.STATIC_PROXY_TARGET ?? '').port, '58800');
  assert.equal(new URL(env.OBJECT_STORE_URL ?? '').port, '58800');
});

test('a STATIC_PROXY_TARGET left in .env or the shell cannot point vite at another stack', () => {
  const env = buildOvermindEnv(
    { STATIC_PROXY_TARGET: 'http://localhost:9000' },
    { ...SOLO, objPort: 58800 },
    STACK,
  );

  assert.equal(env.STATIC_PROXY_TARGET, 'http://127.0.0.1:58800');
});

test('the api listens on loopback unless DEV_LISTEN_HOST opens it up', () => {
  const on = (platform: NodeJS.Platform, base: NodeJS.ProcessEnv = {}) =>
    buildOvermindEnv(base, SOLO, { ...STACK, platform }).API_LISTEN_HOST;

  assert.equal(on('darwin'), '127.0.0.1');
  // Native Linux Docker reaches the host through the bridge gateway, so the
  // sidecars' callbacks need more than loopback there.
  assert.equal(on('linux'), '0.0.0.0');

  assert.equal(on('darwin', { DEV_LISTEN_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(on('linux', { DEV_LISTEN_HOST: '127.0.0.1' }), '127.0.0.1');

  // An API_LISTEN_HOST left in .env does not override the choice.
  assert.equal(on('darwin', { API_LISTEN_HOST: '0.0.0.0' }), '127.0.0.1');
});
