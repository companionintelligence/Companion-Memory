/**
 * ports — the host port each of a worktree stack's services is published on.
 *
 * Every service prefers its conventional default and falls back to an
 * ephemeral port when something else already holds it, so the main checkout
 * working solo gets stable, familiar ports and concurrent worktrees never
 * collide.
 *
 * The allocation is one StackPorts record, and everything host-side that has
 * to reach a service is wired from it: the compose port mappings, the Caddy
 * route, and the Procfile processes' env (./overmind-env). A consumer that
 * falls back to a conventional default instead reaches whichever stack holds
 * that default — which is how vite's `/static` proxy served a sibling
 * worktree's object store on 9000 while Caddy's `/static` route served this
 * stack's own.
 */
import net from 'node:net';
import { spawnSync } from 'node:child_process';

// Conventional default host ports, preferred when free.
export const DEFAULTS = {
  api: 3030,
  web: 5173,
  db: 5432,
  objectStore: 9000,
  hbpe: 8002,
  summary: 8001,
  parser: 8003,
  // Not 8080: the shared dev Caddy owns it. The api hands this URL to clients
  // verbatim, so the phone's `adb reverse` must name the same port (yarn android).
  powersync: 18080,
};

/** The host port each service of one stack was allocated. */
export interface StackPorts {
  apiPort: number;
  webPort: number;
  dbPort: number;
  objPort: number;
  hbpePort: number;
  summaryPort: number;
  parserPort: number;
  /** Allocated whether or not the stack runs the service; it costs nothing idle. */
  powersyncPort: number;
}

/** Host ports Docker has published, split by owning compose project. */
export interface PublishedPorts {
  own: Set<number>;
  foreign: Set<number>;
}

/** True if something is already listening on the port — including a Docker
 * container another worktree published on 0.0.0.0. We *connect* rather than
 * bind-test: a bind on 127.0.0.1 falsely reports "free" because Node sets
 * SO_REUSEADDR, so the loopback bind coexists with an existing 0.0.0.0:<port>
 * bind — and then `docker compose up` fails with "port is already allocated".
 * (Binding 0.0.0.0 would detect it but trips the macOS firewall prompt.) A
 * refused/failed/timed-out connection means free; a successful one means taken. */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (taken: boolean) => {
      socket.destroy();
      resolve(taken);
    };

    socket.setTimeout(500);
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

/** Host ports Docker has already published, split by whether they belong to
 * THIS compose project. Reading them is the authoritative check for container
 * port conflicts: Docker Desktop on macOS publishes via its VM and the host
 * port frequently isn't reachable on IPv4 loopback (it listens on IPv6 `*`), so
 * a bind- or connect-test misses it — yet `docker compose up` still fails with
 * "port is already allocated".
 *
 * The split matters because this stack's own containers are not a conflict:
 * `compose up` recreates them on whatever ports we pass it. Counting them as
 * taken is how a stack displaced itself onto ephemeral ports — the services
 * carry `restart: unless-stopped`, so a reboot without a clean `composeStop`
 * has the daemon bring them back on the defaults, and the next `make dev`
 * (which allocates before it ever calls compose) then read its own containers
 * as foreign squatters and fell back to ephemeral for every service.
 * `make dev-down` did not help: it only tears down the Caddy route. */
export function dockerPublishedPorts(key: string): PublishedPorts {
  const res = spawnSync('docker', ['ps', '--format', '{{.Label "com.docker.compose.project"}}\t{{.Ports}}'], {
    encoding: 'utf8',
  });
  const own = new Set<number>();
  const foreign = new Set<number>();

  for (const line of (res.stdout ?? '').split('\n')) {
    if (!line.trim()) {
      continue;
    }

    const tab = line.indexOf('\t');
    const project = tab === -1 ? '' : line.slice(0, tab);
    const target = project === key ? own : foreign;

    for (const match of line.slice(tab + 1).matchAll(/:(\d+)->/g)) {
      target.add(Number(match[1]));
    }
  }

  return { own, foreign };
}

/** Preferred port if free, else an ephemeral one. "Free" means not published by
 * another project's containers (covers other worktrees' stacks) and not
 * answering a connection (covers host processes like another stack's api/web).
 *
 * A port this project already publishes stays preferred: it is ours to reuse,
 * and the live connection it answers is our own container — the very thing the
 * connect-test must not read as a conflict, since `compose up` will rebind it
 * anyway. The ephemeral fallback still avoids every Docker-published port,
 * ours included, so a service that genuinely has to move can't land on a
 * sibling's. (Small TOCTOU window before the consumer binds — acceptable for
 * local dev.) */
export async function allocPort(preferred: number, dockerPorts: PublishedPorts): Promise<number> {
  if (dockerPorts.own.has(preferred)) {
    return preferred;
  }

  if (!dockerPorts.foreign.has(preferred) && !(await portTaken(preferred))) {
    return preferred;
  }

  let port = await ephemeralPort();
  while (dockerPorts.own.has(port) || dockerPorts.foreign.has(port)) {
    port = await ephemeralPort();
  }

  return port;
}

/** Every service's port for one stack, allocated concurrently. */
export async function allocStackPorts(dockerPorts: PublishedPorts): Promise<StackPorts> {
  const [apiPort, webPort, dbPort, objPort, hbpePort, summaryPort, parserPort, powersyncPort] =
    await Promise.all([
      allocPort(DEFAULTS.api, dockerPorts),
      allocPort(DEFAULTS.web, dockerPorts),
      allocPort(DEFAULTS.db, dockerPorts),
      allocPort(DEFAULTS.objectStore, dockerPorts),
      allocPort(DEFAULTS.hbpe, dockerPorts),
      allocPort(DEFAULTS.summary, dockerPorts),
      allocPort(DEFAULTS.parser, dockerPorts),
      allocPort(DEFAULTS.powersync, dockerPorts),
    ]);

  return { apiPort, webPort, dbPort, objPort, hbpePort, summaryPort, parserPort, powersyncPort };
}
