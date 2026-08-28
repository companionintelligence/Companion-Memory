/**
 * Two CI-Server boxes, one federated ask, and a human watching consent work.
 *
 *   yarn fed up      — bring both boxes and the local issuer up (idempotent)
 *   yarn fed seed    — owners, peer links, grants, fixture calendar (idempotent)
 *   yarn fed run     — the five scenarios, asserted
 *   yarn fed demo    — up + seed + run
 *   yarn fed status  — what is running, and where the logs are
 *   yarn fed down    — stop everything (add --purge to drop the databases)
 *   yarn fed token   — mint a token for poking at a box by hand
 *
 * See ./README.md. Everything about WHY it is shaped this way lives in the
 * module headers: topology.ts (why not `make dev` twice), idp.ts (why a
 * 90-line issuer is enough), scenarios.ts (why the driver, not sendPeerAsk).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import { mintToken, startIdp } from './idp';
import { importRealData } from './realData';
import { runScenarios, type Context } from './scenarios';
import {
  GRANTS,
  countCalendarEvents,
  countIndexedEvents,
  ensureActiveGrant,
  ensurePeerLink,
  ingestFixtureCalendar,
  provisionOwner,
  withClient,
} from './seed';
import {
  composeDestroy,
  composeStop,
  composeUp,
  ensureDotenv,
  isAlive,
  migrate,
  sleep,
  startApi,
  stopApi,
  waitForApi,
  waitForSetupDatabase,
} from './stack';
import {
  BOXES,
  STATE_DIR,
  allocPort,
  clearState,
  composeProject,
  graphqlEndpoint,
  memoryEndpoint,
  readState,
  writeState,
  type BoxId,
  type HarnessState,
} from './topology';

const BOX_IDS: BoxId[] = ['a', 'b'];
const DEFAULT_IDP_PORT = 14000;

function logPath(box: BoxId): string {
  return path.join(STATE_DIR, `box-${box}.log`);
}

function workerLogPath(box: BoxId): string {
  return path.join(STATE_DIR, `box-${box}-worker.log`);
}

// ── up ───────────────────────────────────────────────────────────────────────

async function up(): Promise<void> {
  ensureDotenv();

  const existing = readState();
  const idpPort = existing?.idpPort ?? (await allocPort(DEFAULT_IDP_PORT));

  const state: HarnessState = existing ?? {
    version: 1,
    startedAt: new Date().toISOString(),
    idpPort,
    boxes: {
      a: { apiPort: 0, dbPort: 0, objectStorePort: 0 },
      b: { apiPort: 0, dbPort: 0, objectStorePort: 0 },
    },
  };

  for (const box of BOX_IDS) {
    const identity = BOXES[box];
    const runtime = state.boxes[box];

    // Ports are re-used from the state file when a box is already up, so a
    // second `up` does not move a peer endpoint out from under a peer link.
    if (runtime.apiPort === 0) {
      runtime.apiPort = await allocPort(identity.preferred.api);
      runtime.dbPort = await allocPort(identity.preferred.db);
      runtime.objectStorePort = await allocPort(identity.preferred.objectStore);
    }

    console.log(
      `\n▶ box ${box.toUpperCase()} (${identity.displayName}) — compose project ${composeProject(box)}`,
    );
    console.log(
      `  api :${runtime.apiPort}   postgres :${runtime.dbPort}   object-store :${runtime.objectStorePort}`,
    );

    composeUp(box, runtime);
    await waitForSetupDatabase(box, runtime);
    migrate(box, runtime);
  }

  writeState(state);

  // The issuer must outlive this command: jose re-fetches the JWKS on a cache
  // miss, so a box that boots while the issuer is down verifies nothing.
  if (!isAlive(state.idpPid)) {
    const child = spawn(
      'yarn',
      [
        'workspace',
        '@ci/be-api',
        'run',
        'exec',
        '--',
        'scripts/federation-harness/index.ts',
        'serve-idp',
        String(state.idpPort),
      ],
      {
        cwd: path.resolve(__dirname, '../../../../..'),
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    child.unref();
    state.idpPid = child.pid;
    writeState(state);
  }

  const idp = idpUrls(state.idpPort);
  console.log(`\n▶ local OIDC issuer on ${idp.issuer}  (fixture key — see INSECURE_TEST_KEY.ts)`);
  await waitForJwks(idp.jwksUri);

  for (const box of BOX_IDS) {
    const runtime = state.boxes[box];

    if (!isAlive(runtime.apiPid)) {
      const child = startApi(box, runtime, idp, logPath(box), 'web');
      runtime.apiPid = child.pid;
      writeState(state);
    }

    if (!isAlive(runtime.workerPid)) {
      const worker = startApi(box, runtime, idp, workerLogPath(box), 'worker');
      runtime.workerPid = worker.pid;
      writeState(state);
    }
  }

  console.log('\n▶ waiting for both APIs to boot (NestJS under ts-node is slow the first time)…');

  for (const box of BOX_IDS) {
    await waitForApi(state.boxes[box]);
    console.log(`  ✓ box ${box.toUpperCase()} healthy on :${state.boxes[box].apiPort}`);
  }

  writeState(state);
  await status();
}

function idpUrls(port: number): { issuer: string; jwksUri: string } {
  const issuer = `http://127.0.0.1:${port}`;

  return { issuer, jwksUri: `${issuer}/.well-known/jwks.json` };
}

async function waitForJwks(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }

    await sleep(500);
  }

  throw new Error(`the local issuer never served ${url}`);
}

// ── seed ─────────────────────────────────────────────────────────────────────

async function seed(): Promise<Context> {
  const state = requireState();
  const idp = idpUrls(state.idpPort);

  console.log('\n▶ owners');
  for (const box of BOX_IDS) {
    const runtime = state.boxes[box];
    const { userId, apiKey } = provisionOwner(box, runtime);
    runtime.userId = userId;
    runtime.apiKey = apiKey;
    console.log(`  ✓ box ${box.toUpperCase()}  ${BOXES[box].email}  ${userId}`);
  }

  writeState(state);

  console.log('\n▶ peer links (hand-written rows — no mutation creates one; see docs/peer-federation.md)');

  // Each box holds its OWN half of the relationship. There is no central
  // registry of the graph: CI-Portal only ever answers "handle → endpoint +
  // issuer", never "who knows whom".
  const linkOnB = await withClient(state.boxes.b, (client) =>
    ensurePeerLink(client, {
      ownerUserId: state.boxes.b.userId as string,
      peerHandle: BOXES.a.handle,
      displayName: BOXES.a.displayName,
      memoryEndpoint: memoryEndpoint(state.boxes.a.apiPort),
      peerIssuer: idp.issuer,
      peerSubject: BOXES.a.subject,
      // Configurable posture. `trusted` gives a '*' ceiling of `redacted`, which
      // is deliberately ABOVE the `count` the availability grant imposes — so
      // scenario (d) shows the grant tightening the tier, not agreeing with it.
      trustTier: process.env.FED_TRUST_TIER ?? 'trusted',
    }),
  );
  console.log(
    `  ✓ on box B: @${BOXES.a.handle} → ${memoryEndpoint(state.boxes.a.apiPort)}  (${process.env.FED_TRUST_TIER ?? 'trusted'})`,
  );

  await withClient(state.boxes.a, (client) =>
    ensurePeerLink(client, {
      ownerUserId: state.boxes.a.userId as string,
      peerHandle: BOXES.b.handle,
      displayName: BOXES.b.displayName,
      memoryEndpoint: memoryEndpoint(state.boxes.b.apiPort),
      peerIssuer: idp.issuer,
      peerSubject: BOXES.b.subject,
      trustTier: process.env.FED_TRUST_TIER ?? 'trusted',
    }),
  );
  console.log(`  ✓ on box A: @${BOXES.b.handle} → ${memoryEndpoint(state.boxes.b.apiPort)}`);

  console.log('\n▶ standing grants on box B (the responder)');
  const grants: Record<string, string> = {};

  await withClient(state.boxes.b, async (client) => {
    for (const spec of GRANTS) {
      const { id, created } = await ensureActiveGrant(client, state.boxes.b.userId as string, linkOnB, spec);
      grants[spec.label] = id;
      console.log(`  ${created ? '✓' : '·'} ${spec.label.padEnd(34)} ${spec.why}`);
    }
  });

  console.log('\n▶ fixture calendar on box B (through POST /v1/events — the real ingest route)');
  await ingestFixtureCalendar(state.boxes.b);

  // The materializer and the tsvector stage are queue-driven, so the rows are
  // not there the instant the POST returns. Poll rather than sleep-and-hope: an
  // availability answer over an empty calendar looks exactly like a ceiling
  // working, and that would make scenario (d) prove nothing.
  const materialized = await waitFor(
    () => withClient(state.boxes.b, (client) => countCalendarEvents(client, state.boxes.b.userId as string)),
    (n) => n >= 3,
    60_000,
  );
  console.log(`  ✓ ${materialized} calendar event(s) materialized in ci.events`);

  // The keyword index is written by a PIPELINE stage (`index.vector_event`), not
  // by the ingest request, and the pipeline is driven by a periodic control
  // tick — so the vectors appear a minute or two after the events materialize,
  // not with them. Waiting only 60s here is what made the first green run report
  // "0 matching items" for every CONTENT ask while the rows landed moments later.
  const indexed = await waitFor(
    () => withClient(state.boxes.b, (client) => countIndexedEvents(client, state.boxes.b.userId as string)),
    (n) => n >= 3,
    240_000,
  ).catch(() => 0);

  if (indexed >= 3) {
    console.log(
      `  ✓ ${indexed} event(s) in ci_search.vectors (the keyword index the CONTENT archetype searches)`,
    );
  } else {
    console.log(
      `  ! only ${indexed} event(s) reached ci_search.vectors — the CONTENT asks will still run and still` +
        ' prove their consent decisions, but they will report a disclosed count of 0.',
    );
  }

  writeState(state);

  return {
    boxA: state.boxes.a,
    boxB: state.boxes.b,
    idpIssuer: idp.issuer,
    responderUserId: state.boxes.b.userId as string,
    peerLinkId: linkOnB,
    grants,
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();

  while (!done(last) && Date.now() < deadline) {
    await sleep(2000);
    last = await read();
  }

  if (!done(last)) {
    throw new Error(`condition not met within ${timeoutMs}ms (last value: ${JSON.stringify(last)})`);
  }

  return last;
}

// ── run ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Always re-seed first. A previous run REVOKES two grants on purpose, and
  // grants are append-only — so "make the seeded posture true again" means
  // writing fresh rows, not un-revoking old ones. That is what makes `fed run`
  // re-runnable without a teardown.
  const ctx = await seed();
  const result = await runScenarios(ctx);

  console.log(`\n${'─'.repeat(78)}`);
  console.log(
    `  ${result.failed === 0 ? '[32m' : '[31m'}${result.passed} passed, ${result.failed} failed[0m`,
  );

  for (const failure of result.failures) {
    console.log(`    ✗ ${failure}`);
  }

  console.log(`${'─'.repeat(78)}\n`);

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

// ── status / down ────────────────────────────────────────────────────────────

async function status(): Promise<void> {
  const state = readState();

  if (state == null) {
    console.log('\nNothing recorded. Run `make fed-up`.\n');

    return;
  }

  const idp = idpUrls(state.idpPort);
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`  issuer   ${idp.issuer}   jwks ${idp.jwksUri}`);

  for (const box of BOX_IDS) {
    const runtime = state.boxes[box];
    const alive = `${isAlive(runtime.apiPid) ? 'up' : 'down'}, worker ${isAlive(runtime.workerPid) ? 'up' : 'down'}`;
    console.log(
      `  box ${box.toUpperCase()}    ${graphqlEndpoint(runtime.apiPort)}  (${alive})\n` +
        `           peer endpoint ${memoryEndpoint(runtime.apiPort)}\n` +
        `           postgres localhost:${runtime.dbPort}   log ${logPath(box)}`,
    );
  }

  console.log(`${'─'.repeat(78)}\n`);
}

function down(purge: boolean): void {
  const state = readState();

  if (state == null) {
    console.log('Nothing recorded; nothing to stop.');

    return;
  }

  for (const box of BOX_IDS) {
    stopApi(state.boxes[box].apiPid);
    stopApi(state.boxes[box].workerPid);
  }

  stopApi(state.idpPid);

  for (const box of BOX_IDS) {
    if (purge) {
      composeDestroy(box, state.boxes[box]);
    } else {
      composeStop(box, state.boxes[box]);
    }
  }

  if (purge) {
    clearState();
    console.log('\nBoth boxes destroyed, volumes dropped, state cleared.\n');
  } else {
    for (const box of BOX_IDS) {
      state.boxes[box].apiPid = undefined;
      state.boxes[box].workerPid = undefined;
    }

    // The issuer's pid is cleared for the same reason the boxes' are: a pid on
    // a stopped process can be REUSED, and `isAlive` cannot tell the difference
    // — so a stale one makes the next `up` skip starting the issuer, and both
    // boxes then verify nothing. `waitForJwks` catches it a few seconds later
    // with a clear message, but not starting it at all is the better answer.
    state.idpPid = undefined;

    writeState(state);
    console.log('\nBoth boxes stopped. Databases preserved — `make fed-up` brings them back.\n');
  }
}

// ── entry ────────────────────────────────────────────────────────────────────

function requireState(): HarnessState {
  const state = readState();

  if (state == null || state.boxes.a.apiPort === 0) {
    throw new Error('no running harness — run `make fed-up` first');
  }

  return state;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'up':
      await up();
      break;

    case 'seed':
      await seed();
      break;

    case 'run':
      await run();
      break;

    case 'demo':
      await up();
      await run();
      break;

    case 'status':
      await status();
      break;

    case 'down':
      down(rest.includes('--purge'));
      break;

    case 'import-real-data':
      await importRealData(requireState(), rest);
      break;

    case 'token': {
      const state = requireState();
      const box = (rest[0] as BoxId) ?? 'b';
      console.log(
        await mintToken({
          subject: BOXES[box === 'b' ? 'a' : 'b'].subject,
          audience: BOXES[box].audience,
          issuer: idpUrls(state.idpPort).issuer,
          ttlSeconds: 3600,
        }),
      );
      break;
    }

    case 'serve-idp': {
      // Foreground; `up` spawns this detached. Never returns.
      const handle = await startIdp(Number(rest[0] ?? DEFAULT_IDP_PORT));
      console.log(`federation-harness issuer listening on ${handle.issuer}`);
      await new Promise(() => undefined);
      break;
    }

    default:
      console.log(
        [
          '',
          'usage: yarn fed <command>',
          '',
          '  up                  bring both boxes and the local issuer up (idempotent)',
          '  seed                owners, peer links, grants, fixture calendar (idempotent)',
          '  run                 seed, then drive the five scenarios with assertions',
          '  demo                up + run',
          '  status              what is running and where the logs are',
          '  down [--purge]      stop both boxes (--purge also drops their databases)',
          '  token [a|b]         mint a token addressed to that box, for manual curl',
          '  import-real-data    load a bounded, read-only subset of a real archive into box A',
          '',
        ].join('\n'),
      );
      process.exitCode = command == null ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n[31m✗ ${(error as Error).message}[0m\n`);
  process.exitCode = 1;
});
