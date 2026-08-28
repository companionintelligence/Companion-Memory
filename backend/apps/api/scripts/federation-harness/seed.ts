/**
 * Idempotent seeding: an owner on each box, a peer link on each side, the
 * responder's standing grants, and a small calendar to answer from.
 *
 * ═══ WHAT "IDEMPOTENT" HAS TO MEAN FOR A GRANT ═══
 *
 * Not "INSERT with a fixed id". `ci.ask_grants` is APPEND-ONLY by design —
 * `revoke` stamps `revoked_at`, `supersede` closes a row and writes a
 * replacement, and nothing is ever rewritten in place, because consent history
 * is evidence. The revocation scenario deliberately revokes one of these grants,
 * so a fixed-id upsert would either resurrect a revoked grant (destroying the
 * evidence the table exists to keep) or refuse to re-seed at all.
 *
 * So the unit of idempotency is "an ACTIVE grant matching this posture exists".
 * A re-seed after a revocation writes a NEW row, and the revoked one stays in
 * the history exactly where the owner left it — which is also what `make
 * fed-demo` needs to be re-runnable.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { connect } from './stack';
import { REPO_ROOT, BOXES, type BoxId, type BoxRuntime } from './topology';

/** Grant postures the responder (box B) holds for the asker (box A). */
export interface GrantSpec {
  label: string;
  queryType: string;
  dataClass: string | null;
  mode: 'auto' | 'review' | 'block';
  scope: Record<string, unknown> | null;
  why: string;
}

/**
 * The four postures the scenarios exercise.
 *
 * Note what is NOT here: a grant for `content` / `documents`. That omission is
 * load-bearing — `evaluateGrant` returns `review` when nothing matches, so the
 * review scenario proves the DEFAULT rather than a configured posture, which is
 * the more important property ("owner review is the floor, there is never
 * implicit open access").
 */
export const GRANTS: GrantSpec[] = [
  {
    label: 'auto/events',
    queryType: 'content',
    dataClass: 'events',
    mode: 'auto',
    scope: null,
    why: 'standing pre-authorization — answers without interrupting the owner',
  },
  {
    label: 'block/messages',
    queryType: 'content',
    dataClass: 'messages',
    mode: 'block',
    scope: null,
    why: 'an explicit refusal that always beats a broader auto grant',
  },
  {
    label: 'auto/calendar capped at count',
    queryType: 'availability',
    dataClass: 'calendar',
    mode: 'auto',
    // The ceiling #2219 gave a writer. `count` sits two rungs below the
    // `redacted` this peer's `trusted` tier would otherwise allow, so the
    // difference between the two is observable on the wire.
    scope: { maxDisclosure: 'count' },
    why: 'auto-answerable, but capped: the peer learns HOW MANY free slots, never WHEN',
  },
  {
    label: 'review/photos',
    queryType: 'content',
    dataClass: 'photos',
    mode: 'review',
    scope: null,
    why: 'an explicit "ask me first" posture, named in the owner’s inbox',
  },
];

/**
 * Provision the local owner account and an API key, by shelling out to the
 * repo's own `scripts/create-test-user.ts`.
 *
 * Deliberately not reimplemented: that script's header calls out that the key
 * derivation is "a contract with ApiKeyService.hash" (sha256 of a 64-hex raw
 * key), and a second copy of that contract in this file is a second place for it
 * to rot. It is already non-interactive, env-driven and idempotent for the user
 * — it was written for exactly this.
 */
export function provisionOwner(box: BoxId, runtime: BoxRuntime): { userId: string; apiKey: string } {
  const identity = BOXES[box];

  const result = spawnSync(
    'yarn',
    ['workspace', '@ci/be-api', 'run', 'exec', '--', 'scripts/create-test-user.ts'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_HOST: 'localhost',
        DATABASE_PORT: String(runtime.dbPort),
        TEST_USER_EMAIL: identity.email,
        TEST_USER_NAME: identity.displayName,
        TEST_KEY_NAME: 'federation-harness',
        // Empty = full user authority. The harness calls both the ingest routes
        // (`/v1/events`) and GraphQL; a scoped key is refused by ingest with a
        // 403, which is the trap that script's header warns about.
        TEST_KEY_SCOPES: '',
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(`create-test-user failed for box ${box}:\n${result.stdout}\n${result.stderr}`);
  }

  const userId = /^User id\s+(\S+)$/m.exec(result.stdout)?.[1];
  const apiKey = /^API key\s+([0-9a-f]{64})$/m.exec(result.stdout)?.[1];

  if (!userId || !apiKey) {
    throw new Error(`could not parse create-test-user output for box ${box}:\n${result.stdout}`);
  }

  return { userId, apiKey };
}

/**
 * Write (or refresh) the peer link this box holds for the other box.
 *
 * There is no mutation and no REST route that creates a peer link — `docs/
 * peer-federation.md` says so under Known limitations, and `PeerLinkService
 * .upsert` has no caller outside its own tests. A hand-written row is the
 * SUPPORTED way to link two boxes today, not a shortcut around an API.
 *
 * `trust_tier` note: the CHECK on this column admits only
 * ('family','trusted','peer','stranger'). `household` is in the TypeScript
 * `TrustTier` union but is the LOCAL tier — a peer can never be one, and trying
 * lands a 23514 rather than a validation error.
 */
export async function ensurePeerLink(
  client: Client,
  params: {
    ownerUserId: string;
    peerHandle: string;
    displayName: string;
    memoryEndpoint: string;
    peerIssuer: string;
    peerSubject: string;
    trustTier: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ci.peer_links
       (id, owner_user_id, peer_handle, display_name, memory_endpoint,
        peer_issuer, peer_subject, trust_tier, status, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NULL)
     ON CONFLICT (owner_user_id, peer_handle) DO UPDATE SET
       display_name    = EXCLUDED.display_name,
       memory_endpoint = EXCLUDED.memory_endpoint,
       peer_issuer     = EXCLUDED.peer_issuer,
       peer_subject    = EXCLUDED.peer_subject,
       trust_tier      = EXCLUDED.trust_tier,
       -- Re-activating on re-seed is what makes the harness re-runnable after a
       -- scenario revokes the link. The grants riding it are NOT resurrected;
       -- those are append-only and handled by ensureActiveGrant below.
       status          = 'active',
       revoked_at      = NULL,
       updated_at      = NOW()
     RETURNING id`,
    [
      randomUUID(),
      params.ownerUserId,
      params.peerHandle,
      params.displayName,
      params.memoryEndpoint,
      params.peerIssuer,
      params.peerSubject,
      params.trustTier,
    ],
  );

  return rows[0].id;
}

/**
 * Ensure an ACTIVE grant with this posture exists, without ever un-revoking one.
 *
 * The liveness predicate is spelled the same way `isGrantActive` spells it —
 * `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())` — because
 * a second, subtly different copy of that predicate is exactly how a revoked
 * grant keeps answering.
 */
export async function ensureActiveGrant(
  client: Client,
  ownerUserId: string,
  granteePeerLinkId: string,
  spec: GrantSpec,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ci.ask_grants
      WHERE owner_user_id = $1
        AND grantee_peer_link_id = $2
        AND query_type = $3
        AND data_class IS NOT DISTINCT FROM $4
        AND mode = $5
        AND scope IS NOT DISTINCT FROM $6::jsonb
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      ownerUserId,
      granteePeerLinkId,
      spec.queryType,
      spec.dataClass,
      spec.mode,
      spec.scope ? JSON.stringify(spec.scope) : null,
    ],
  );

  if (existing.rows.length > 0) {
    return { id: existing.rows[0].id, created: false };
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ci.ask_grants
       (id, owner_user_id, grantee_user_id, grantee_peer_link_id, query_type, data_class, scope, mode, version)
     VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7, 1)
     RETURNING id`,
    [
      randomUUID(),
      ownerUserId,
      granteePeerLinkId,
      spec.queryType,
      spec.dataClass,
      spec.scope ? JSON.stringify(spec.scope) : null,
      spec.mode,
    ],
  );

  return { id: rows[0].id, created: true };
}

/**
 * The responder's calendar, ingested through `POST /v1/events` — the SAME route
 * a capture client uses, not an INSERT.
 *
 * Going through ingest rather than writing `ci.events` directly buys three
 * things the scenarios depend on: the rows are materialized by the real
 * materializer (so `is_deleted`, `user_id` and the provenance triple are what
 * the availability query expects), the provenance triple makes re-ingest
 * idempotent rather than duplicating the calendar on every seed, and the
 * pipeline writes the `ci_search.vectors` tsvector row that the CONTENT
 * archetype searches. None of that needs Ollama — the tsvector is computed by
 * Postgres (`vectorStages.ts`: "Local cost — the tsvector is computed by
 * Postgres itself").
 *
 * The times are anchored to a FIXED calendar day rather than "tomorrow", so two
 * runs on different days produce the same free/busy answer and a diff between
 * two transcripts means something.
 */
export const FIXTURE_DAY = '2026-09-15';

export function fixtureEvents(): unknown[] {
  const day = FIXTURE_DAY;

  return [
    {
      source_type: 'federation-harness',
      source_system: 'fixture-calendar',
      source_id: `${day}-standup`,
      kind: 'calendar.event',
      occurred_at: `${day}T16:00:00.000Z`,
      ended_at: `${day}T16:30:00.000Z`,
      title: 'Design standup with the atlas team',
      description: 'Weekly sync on the spatial memory globe.',
      payload: {},
    },
    {
      source_type: 'federation-harness',
      source_system: 'fixture-calendar',
      source_id: `${day}-lunch`,
      kind: 'calendar.event',
      occurred_at: `${day}T19:00:00.000Z`,
      ended_at: `${day}T20:00:00.000Z`,
      title: 'Lunch at Zuni',
      description: 'Long-standing Tuesday lunch.',
      payload: {},
    },
    {
      source_type: 'federation-harness',
      source_system: 'fixture-calendar',
      source_id: `${day}-review`,
      kind: 'calendar.event',
      occurred_at: `${day}T22:00:00.000Z`,
      ended_at: `${day}T23:00:00.000Z`,
      title: 'Quarterly review',
      description: 'Numbers and the roadmap.',
      payload: {},
    },
  ];
}

/** POST the fixture calendar into a box through its own ingest route. */
export async function ingestFixtureCalendar(runtime: BoxRuntime): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${runtime.apiPort}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': runtime.apiKey ?? '',
    },
    body: JSON.stringify({ events: fixtureEvents() }),
  });

  if (!response.ok) {
    throw new Error(`fixture calendar ingest failed: ${response.status} ${await response.text()}`);
  }

  return fixtureEvents().length;
}

/** How many of the responder's calendar events actually materialized. */
export async function countCalendarEvents(client: Client, userId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ci.events
      WHERE user_id = $1 AND is_deleted = false
        AND start_time >= $2::timestamptz AND start_time < ($2::timestamptz + interval '1 day')`,
    [userId, `${FIXTURE_DAY}T00:00:00Z`],
  );

  return Number(rows[0].n);
}

/** How many of them reached the keyword index the CONTENT archetype searches. */
export async function countIndexedEvents(client: Client, userId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ci_search.vectors WHERE user_id = $1 AND entity_type = 'event'`,
    [userId],
  );

  return Number(rows[0].n);
}

export async function withClient<T>(runtime: BoxRuntime, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect(runtime);

  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
