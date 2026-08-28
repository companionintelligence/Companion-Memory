/**
 * The two boxes, their ports, and the state file that remembers a live run.
 *
 * ═══ WHY THIS IS NOT `make dev` TWICE ═══
 *
 * `scripts/dev-stack` already isolates a stack per worktree — its own compose
 * project, its own volumes, its own ephemeral ports — so two worktrees running
 * `make dev` genuinely are two boxes. It was rejected here for three reasons,
 * none of them "it does not work":
 *
 *   1. IT ALLOCATES EPHEMERAL PORTS AND RE-ROLLS THEM EVERY RUN. `composeEnv`
 *      spreads `process.env` and then OVERWRITES all seven port variables, so a
 *      caller cannot pin them. A harness whose peer endpoints move on every
 *      bring-up cannot write a stable `ci.peer_links.memory_endpoint`.
 *   2. IT IS A FOREGROUND tmux SUPERVISOR (overmind), and it demands Caddy on
 *      :443 with its admin API, Ollama on :11434, and will `ollama pull` several
 *      GB on a cold machine. A federated ask is an API-to-API event; none of the
 *      browser-facing half is load-bearing for it.
 *   3. IT NEEDS A SECOND WORKTREE, i.e. a second checkout of this branch, which
 *      is not something a README can ask an owner to maintain.
 *
 * So the harness reuses the same PRIMITIVES at the level that matters — the
 * same two compose files, the same `COMPOSE_PROJECT_NAME`-scoped volumes, the
 * same `DB_HOST_PORT` / `OBJECT_STORE_HOST_PORT` variables, the same
 * `yarn workspace @ci/be-api migrate` — and boots the API the way
 * `playwright.e2e.config.ts` already does: a plain node process with `PORT` and
 * `DATABASE_PORT` in its environment. That file is the in-repo precedent for
 * "run the stack without Caddy or Overmind"; this is the two-box version of it.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** Repo root, resolved from this file rather than from `process.cwd()` — the
 *  harness is launched through `yarn workspace @ci/be-api`, whose cwd is the
 *  workspace dir, not the root where the compose files live. */
export const REPO_ROOT = path.resolve(__dirname, '../../../../..');

/** Where a live run records what it allocated. Gitignored; see .gitignore. */
export const STATE_DIR = path.join(REPO_ROOT, '.federation-harness');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');

export type BoxId = 'a' | 'b';

export interface BoxIdentity {
  id: BoxId;
  /** Portal-style handle. Written to `ci.peer_links.peer_handle` on the OTHER box. */
  handle: string;
  displayName: string;
  /** Local account on this box. */
  email: string;
  /**
   * OIDC subject this box's owner presents when asking a peer. The receiving
   * box matches it against `peer_links.peer_subject` — the (issuer, subject)
   * pair IS the peer's identity, so this is the only thing that attributes an
   * inbound ask to a known peer rather than a stranger.
   */
  subject: string;
  /**
   * This box's own `peers.audience`. A token is addressed to a box by naming
   * this in `aud`; `PeerAskController` passes it to `verifyClaims` as the ONLY
   * acceptable audience, so a token minted for box A is rejected by box B.
   */
  audience: string;
  /** Conventional host ports, used when free (see allocPort). */
  preferred: { api: number; db: number; objectStore: number };
}

/**
 * Box A asks; box B answers. Both run the same code and both have a peer link
 * pointing at the other, so the roles are a property of the scenario, not of
 * the topology — the driver could reverse them without changing anything here.
 */
export const BOXES: Record<BoxId, BoxIdentity> = {
  a: {
    id: 'a',
    handle: 'ada',
    displayName: 'Ada (box A)',
    email: 'ada@federation-harness.test',
    subject: 'urn:ci-federation-harness:ada',
    audience: 'ci-federation-harness-box-a',
    // Deliberately far from the conventional 3030/5432/9000 so a harness run
    // never displaces a `make dev` stack the owner already has up.
    preferred: { api: 13030, db: 15432, objectStore: 19000 },
  },
  b: {
    id: 'b',
    handle: 'devon',
    displayName: 'Devon (box B)',
    email: 'devon@federation-harness.test',
    subject: 'urn:ci-federation-harness:devon',
    audience: 'ci-federation-harness-box-b',
    preferred: { api: 13031, db: 15433, objectStore: 19001 },
  },
};

/** Compose project for a box. Drives volume names, so it is also the data boundary. */
export function composeProject(box: BoxId): string {
  return `ci-server-fedharness-${box}`;
}

export interface BoxRuntime {
  apiPort: number;
  dbPort: number;
  objectStorePort: number;
  /** PID of the API process this harness spawned, if it is still ours to stop. */
  apiPid?: number;
  /** PID of its headless worker — the half that consumes the import stage queues. */
  workerPid?: number;
  /** API key minted by `seed`, for the owner-side GraphQL calls. */
  apiKey?: string;
  /** Local user id, for writing peer links and grants. */
  userId?: string;
}

export interface HarnessState {
  version: 1;
  startedAt: string;
  idpPort: number;
  /** PID of the detached issuer process, so `down` can stop the one it started. */
  idpPid?: number;
  boxes: Record<BoxId, BoxRuntime>;
}

export function readState(): HarnessState | null {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as HarnessState;
  } catch {
    // A truncated state file is a stale run, not a fatal condition — `down`
    // must still be able to clean up, and it falls back to the preferred ports.
    return null;
  }
}

export function writeState(state: HarnessState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function clearState(): void {
  if (fs.existsSync(STATE_FILE)) {
    fs.rmSync(STATE_FILE);
  }
}

/**
 * True when something already answers on the port.
 *
 * Connect rather than bind, for the reason `scripts/dev-stack` documents at
 * length: Node sets SO_REUSEADDR, so a loopback bind-test coexists with an
 * existing `0.0.0.0:<port>` bind from another stack's container and reports
 * "free" right up until `docker compose up` fails with "port is already
 * allocated".
 */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };

    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Preferred port when free, else an ephemeral one recorded in the state file. */
export async function allocPort(preferred: number): Promise<number> {
  return (await portTaken(preferred)) ? ephemeralPort() : preferred;
}

/** The peer endpoint another box POSTs its asks to. `/ask` is appended by the client. */
export function memoryEndpoint(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}/agent/v1`;
}

export function graphqlEndpoint(apiPort: number): string {
  return `http://127.0.0.1:${apiPort}/graphql`;
}
