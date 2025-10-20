# Graph Domain Testing Guide

The graph domain captures user knowledge in a unified node/relationship store. Feature domains publish “intent” events for writes, and the graph module consumes those events to persist the actual nodes and edges. Reads go through a shared query façade so every caller sees the same view, including tooling and LLM context builders.

At a glance: controllers and services emit graph mutations via `GraphEventService`; a `GraphEventListener` handles those events asynchronously and writes to the database; `GraphQueryService` and `UserContextService` provide consistent read APIs; the frontend and tooling rely on the same HTTP endpoints. Because writes are async, you verify them by polling the corresponding getter once PgBoss processes the event. This separation keeps feature domains thin, centralizes graph logic, and ensures observability through a single set of listeners and query helpers.

In more detail, setters live in the feature or memory domains, where they validate input and publish `GRAPH_*` events through `GraphEventService`. Those events flow to PgBoss, and the `GraphEventListener` inside `GraphModule` consumes them, invoking the low-level `GraphUtilityService` to upsert nodes, relationships, and linked table information. The graph module exports only read/query services so that write behavior remains event-driven and auditable. Consumers that need read access—controllers, native tools, promotion jobs, or the LLM pipeline—inject `GraphQueryService` (and, when needed, `UserContextService`) to fetch data without touching repositories directly.

Every exported helper has a well-scoped responsibility. `GraphQueryService` offers high-level reads such as `getRelationships`, `getNodesByIds`, `traverseGraph`, and `getUserEntity`. `GraphEventService` wraps all domain writes (adding people, preferences, visits, etc.) into strongly typed events. `GraphUtilityService` remains available for maintenance scripts that need lower-level operations (bulk deactivations, archival). Finally, `UserContextService` composes graph data into markdown so LLM controllers can hydrate the system prompt prior to answering user questions. Because all of these live under `@ci/domains/graph`, teams can wire them into other modules simply by importing `GraphModule`.

With those pieces in mind, the rest of this guide shows how to exercise the graph endpoints via cURL, how to invoke the services directly from backend code, and how the frontend can call the same APIs. By walking through the setters and getters, you can validate end-to-end behavior, inspect queued events, and confirm that “reads after write” behave once the worker finishes processing.

This document explains how to exercise the event-driven graph domain from both the API and internal services. It covers:

- How setters ("writes") behave and how to fire them through HTTP (cURL examples)
- How getters ("reads") return data synchronously
- Which services are exported (`GraphQueryService`, `GraphUtilityService`, `UserContextService`, `GraphEventService`) and what they expose
- How the frontend can call the same endpoints with `fetch`

> **Important:** All write operations are asynchronous. Controllers enqueue events via PgBoss and immediately return optimistic responses. Verify writes by calling the read APIs after the worker finishes processing.

## Prerequisites

- `make dev` or a running backend (`backend/apps/api`) with database and PgBoss available
- A valid JWT access token for the authenticated user (substitute `${TOKEN}` below)
- The user ID that maps to the JWT (substitute `${USER_ID}`) when testing direct service calls

All examples assume the API is reachable at `http://localhost:3000`.

---

## Exported services summary

The graph domain lives under `@ci/domains/graph` with write helpers in `@ci/domains/memory`. Import the pieces you need:

| Export | Source | Notes |
| --- | --- | --- |
| `GraphModule` | `backend/apps/api/src/domains/graph/GraphModule.ts` | Nest module that wires all graph services and the event listener. Add this to any module needing graph reads. |
| `GraphQueryService` | `@ci/domains/graph` | Primary read façade. Methods: `getNode`, `getNodes`, `getNodesByIds`, `getNodeByLinkedRecord`, `getUserEntity`, `getRelationships`, `findConceptByName`, `findConnectedEntities`, `collectEntitySnapshot`, `traverseGraph`. |
| `GraphReadService` | `@ci/domains/graph` | Convenience getters for common application flows: `getNode`, `getFamilyMembers`, `getPreferences` (with optional filters). Prefer these when you don’t need full query flexibility. |
| `GraphUtilityService` | `@ci/domains/graph` | Low-level graph operations used by listeners/maintenance jobs (`createOrUpdateNode`, `createOrUpdateRelationship`, traversal, archiving). Prefer `GraphQueryService`/`GraphEventService` elsewhere. |
| `UserContextService` | `@ci/domains/graph` | Builds the rich LLM context with `getUserContextForLLM` and `formatContextForSystemPrompt`. Uses the same query helpers internally. |
| `GraphEventService` | `@ci/domains/memory` | Write façade that publishes `GRAPH_*` events. Methods include `addPerson`, `addFamilyMembers`, `addPreference(s)`, `addLocation`, `addVisit`, `addConnection`, `updateNode`, `deleteNode`, `deleteRelationship`, plus generic `upsertNode`/`upsertRelationship`. |

### Typical usage

```ts
// Read flow
constructor(private readonly graphQuery: GraphQueryService, private readonly graphRead: GraphReadService) {}

await this.graphQuery.getRelationships(userId, {
  entityIds: [personId],
  relationshipTypes: ['PREFERS'],
});

// Or use the simple getter
await this.graphRead.getPreferences(userId, { relationship: 'PREFERS' });

// Write flow
constructor(private readonly graphEvents: GraphEventService) {}

await this.graphEvents.addPerson(userId, dto);

// LLM context
constructor(private readonly userContext: UserContextService) {}

const context = await this.userContext.getUserContextForLLM(userId);
```

---

---

## Testing Setters (writes)

### Add a Person

```bash
curl -X POST http://localhost:3000/graph/person \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "name": "Jane Doe",
    "firstName": "Jane",
    "lastName": "Doe",
    "bio": "Product designer and coffee enthusiast",
    "relationships": [
      {
        "toPersonEntityId": "<existing-entity-id>",
        "type": "FRIEND",
        "strength": 0.8
      }
    ],
    "properties": {
      "favoriteCoffee": "flat white"
    }
  }'
```

### Add Multiple Preferences

```bash
curl -X POST http://localhost:3000/graph/preferences \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "personEntityId": "<person-entity-id>",
    "preferences": [
      { "name": "Cycling", "type": "activity", "strength": 0.9 },
      { "name": "Horror Movies", "type": "genre", "isDislike": true }
    ]
  }'
```

### Record a Visit

```bash
curl -X POST http://localhost:3000/graph/visit \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "personEntityId": "<person-entity-id>",
    "locationEntityId": "<location-entity-id>",
    "date": "2024-07-01",
    "notes": "First time at the new café"
  }'
```

### Update a Node

```bash
curl -X POST http://localhost:3000/graph/node/update \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "entityId": "<entity-id>",
    "name": "Jane “JD” Doe",
    "properties": {
      "nickname": "JD"
    }
  }'
```

### Delete a Relationship

```bash
curl -X POST http://localhost:3000/graph/relationship/delete \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{
    "relationshipId": "<relationship-id>"
  }'
```

---

## Testing Getters (reads)

Reads are synchronous and hit the new `GraphQueryService` through the controller.

### Fetch Graph Data (nodes + relationships)

```bash
curl -X GET http://localhost:3000/graph/data \
  -H "Authorization: Bearer ${TOKEN}"
```

### Retrieve User Context Snapshot

```bash
curl -X GET http://localhost:3000/graph/context \
  -H "Authorization: Bearer ${TOKEN}"
```

### Retrieve Formatted Context (System Prompt)

```bash
curl -X GET http://localhost:3000/graph/context/formatted \
  -H "Authorization: Bearer ${TOKEN}"
```

If a write was enqueued moments earlier, you may need to wait for the PgBoss worker (or inspect the background logs) before these reads reflect changes.

---

## Backend Usage

### Publishing mutations

Services should depend on `GraphEventService` (exported from `@ci/domains/memory`). Example within a Nest service:

```ts
@Injectable()
export class ProfileService {
  constructor(private readonly graphEvents: GraphEventService) {}

  async connectPeople(ownerId: string, fromId: string, toId: string) {
    await this.graphEvents.addConnection(ownerId, {
      fromPersonId: fromId,
      toPersonId: toId,
      connectionType: 'FRIEND',
      context: 'met at conference',
    });
  }
}
```

### Querying graph data

For reads, inject the `GraphQueryService` from `@ci/domains/graph`:

```ts
@Injectable()
export class InsightsService {
  constructor(private readonly graphQuery: GraphQueryService) {}

  async findFavorites(ownerId: string, personId: string) {
    const relationships = await this.graphQuery.getRelationships(ownerId, {
      entityIds: [personId],
      relationshipTypes: ['PREFERS'],
    });

    return relationships.map(({ to_entity_id, properties }) => ({
      conceptId: to_entity_id,
      context: properties?.context ?? 'user preference',
    }));
  }
}
```

`GraphQueryService` also exposes `getNodes`, `getNode`, `findConceptByName`, `findConnectedEntities`, and `traverseGraph` for richer queries.

`GraphReadService` provides ready-made getters when you just need graph staples without specifying filters. Today it supports:

- `getNode(ownerId, entityId)` – passthrough helper.
- `getFamilyMembers(ownerId, options?)` – returns the user’s close family/partner network (SPOUSE/PARENT_OF/CHILD_OF/SIBLING_OF by default).
- `getPreferences(ownerId, options?)` – returns PREFERS/DISLIKES concepts for the user (or a specified entity), with optional relationship/type filters.

### Building LLM context

The `UserContextService` (also re-exported from `@ci/domains/graph`) composes graph data into the markdown system prompt that powers Ollama and other LLM integrations:

```ts
constructor(private readonly userContext: UserContextService) {}

const context = await this.userContext.getUserContextForLLM(ownerId);

if (context) {
  const prompt = this.userContext.formatContextForSystemPrompt(context);
  // attach prompt to the LLM request
}
```

Internally, `UserContextService` now uses the same `GraphQueryService` helpers (`getUserEntity`, `getRelationships`, `getNodesByIds`) so it always reflects the latest graph state once events are processed.

---

## Frontend Usage

Any HTTP client can call the `/graph/*` routes. In the React/Vite app, you can use `fetch` with the session token:

```ts
async function addFamilyMember(token: string, payload: unknown) {
  const res = await fetch('/graph/family', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Failed to add family members: ${res.status}`);
  }

  return res.json();
}
```

For reads, the same pattern applies:

```ts
async function loadGraphData(token: string) {
  const res = await fetch('/graph/data', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error('Unable to load graph data');
  }

  return res.json();
}
```

---

## Observability Tips

- Tail the worker logs (`make dev` runs PgBoss consumers inside the API process). Successful event handling will log under `GraphEventListener`.
- To inspect basic stats, use `GraphQueryService.getRelationships` and `getNodes` directly from a debugger or implement a temporary admin endpoint.
- Remember that writes depend on background processing: if you stop the worker, events remain in PgBoss until it resumes.

---

## Summary

1. **Writes**: Publish through the `/graph/*` HTTP endpoints or `GraphEventService`; the listener (`GraphEventListener`) persists nodes/relationships asynchronously.
2. **Reads**: Use `/graph/context`, `/graph/data`, or call `GraphQueryService`/`UserContextService` for structured results.
3. **Utilities**: Reach for `GraphUtilityService` only when you need lower-level operations (maintenance scripts, exports) that the query/event facades do not cover.
4. **Frontend**: Reuse the REST endpoints with the user’s JWT—responses mirror the structures shown above.
5. **Verification**: Confirm data by calling the read endpoints once the queue has processed the event; use logs to trace `GRAPH_*` event handling.

This workflow keeps the graph decoupled, enforces consistent write behavior, and provides a reliable way to spot-check changes across the API, tooling, and LLM context generation.
