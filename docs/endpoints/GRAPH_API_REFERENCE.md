# Graph API Reference

All routes live under the `/graph` controller in the API service. In the web client they
are accessed via `/api/graph/*` through the Vite proxy.

All requests require a valid JWT Bearer token.

---

## Quick Integration Snippets

### Frontend (React)
```ts
import { fetchJson } from '@ci/common';

const jsonHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

export function createGraphClient(token: string) {
  return {
    addPerson: (payload: AddPersonPayload) =>
      fetchJson<AddPersonResponse>('/api/graph/person', {
        method: 'POST',
        headers: jsonHeaders(token),
        body: JSON.stringify(payload),
      }),
    getGraphData: () =>
      fetchJson<GetGraphDataResponse>('/api/graph/data', {
        headers: { Authorization: `Bearer ${token}` },
      }),
    // ...repeat for the remaining endpoints listed below
  };
}
```

### Backend-to-backend (NestJS)
```ts
@Injectable()
export class GraphApiClient {
  constructor(private readonly http: HttpService) {}

  post<T>(path: string, token: string, body: unknown) {
    return firstValueFrom(
      this.http.post<T>(`${process.env.MEMORY_API_URL}/graph${path}`, body, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).then((res) => res.data);
  }

  get<T>(path: string, token: string) {
    return firstValueFrom(
      this.http.get<T>(`${process.env.MEMORY_API_URL}/graph${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ).then((res) => res.data);
  }
}
```

---

## Endpoint Summary

| Method | Path                       | Purpose |
|--------|---------------------------|---------|
| POST   | `/graph/person`           | Create/update a person node, optionally seeding relationships |
| POST   | `/graph/family`           | Batch-create family members linked to a user |
| POST   | `/graph/preference`       | Add a single preference or dislike |
| POST   | `/graph/preferences`      | Batch insert preferences/dislikes |
| POST   | `/graph/location`         | Create a location node |
| POST   | `/graph/visit`            | Record a visit between a person and a location |
| POST   | `/graph/connection`       | Create a social connection between two people |
| GET    | `/graph/context`          | Retrieve structured user context |
| GET    | `/graph/context/formatted`| Retrieve formatted context (Markdown) |
| GET    | `/graph/data`             | Fetch all nodes + relationships for current user |
| POST   | `/graph/node/delete`      | Soft-delete a node |
| POST   | `/graph/node/update`      | Update node metadata/properties |
| POST   | `/graph/relationship/delete` | Soft-delete a relationship |

All responses include a `{ success: boolean }` flag unless an exception bubbles out.

---

## Detailed Endpoint Reference

### POST `/graph/person`
Create or update a `Person` entity. Optional `relationships` are created via
`GraphUtilityService.createOrUpdateRelationship` (family types are made bidirectional automatically).

```ts
interface AddPersonPayload {
  name: string;
  firstName?: string;
  lastName?: string;
  age?: number;
  bio?: string;
  occupation?: string;
  familyRole?: string;
  email?: string;
  phone?: string;
  properties?: Record<string, unknown>;
  relationships?: Array<{
    toPersonEntityId: string;
    type: string;
    strength?: number;
    bidirectional?: boolean;
    properties?: Record<string, unknown>;
  }>;
}
```

**Response**
```json
{
  "success": true,
  "person": {
    "entityId": "entity-uuid",
    "name": "Jane Smith",
    "properties": { "occupation": "Designer" }
  },
  "relationshipsCreated": 1
}
```

---

### POST `/graph/family`
Convenience batch wrapper for `PersonGraphService.addFamilyMembers`.

```ts
interface AddFamilyPayload {
  userEntityId: string;
  familyMembers: Array<{
    name: string;
    relationship: string; // e.g. 'SPOUSE', 'CHILD_OF'
    age?: number;
    firstName?: string;
    lastName?: string;
    properties?: Record<string, unknown>;
  }>;
}
```

**Response**
```json
{
  "success": true,
  "created": 2,
  "familyMembers": [
    { "entityId": "entity-1", "name": "Jane Smith", "properties": {} },
    { "entityId": "entity-2", "name": "Tommy", "properties": { "age": 8 } }
  ]
}
```

---

### POST `/graph/preference`
Creates (or reuses) a `Concept` node and a `PREFERS`/`DISLIKES` relationship via `PreferenceService.addPreference`.

```ts
interface AddPreferencePayload {
  personEntityId: string;
  name: string;
  type: string;          // e.g. 'cuisine', 'movie_genre'
  isDislike?: boolean;
  strength?: number;
  properties?: Record<string, unknown>;
}
```

**Response**
```json
{
  "success": true,
  "concept": {
    "entityId": "concept-uuid",
    "name": "Italian Cuisine",
    "type": "cuisine"
  },
  "relationship": {
    "id": "rel-uuid",
    "type": "PREFERS",
    "strength": 0.9
  }
}
```

---

### POST `/graph/preferences`
Batch wrapper for `PreferenceService.addPreferences`.

```ts
interface AddPreferencesPayload {
  personEntityId: string;
  preferences: Array<{
    name: string;
    type: string;
    isDislike?: boolean;
    strength?: number;
    properties?: Record<string, unknown>;
  }>;
}
```

**Response**
```json
{
  "success": true,
  "created": 3,
  "preferences": [
    { "conceptId": "concept-1", "name": "Italian Cuisine", "relationshipType": "PREFERS" },
    { "conceptId": "concept-2", "name": "Cycling", "relationshipType": "PREFERS" },
    { "conceptId": "concept-3", "name": "Horror", "relationshipType": "DISLIKES" }
  ]
}
```

---

### POST `/graph/location`
Creates a `Location` node via `LocationGraphService.addLocation`.

```ts
interface AddLocationPayload {
  name: string;
  type: string; // e.g. 'city', 'venue'
  coordinates?: { lat: number; lng: number };
  address?: string;
  properties?: Record<string, unknown>;
}
```

**Response**
```json
{
  "success": true,
  "location": {
    "entityId": "location-uuid",
    "name": "Central Park",
    "type": "park",
    "coordinates": { "lat": 40.785091, "lng": -73.968285 }
  }
}
```

---

### POST `/graph/visit`
Uses `RelationshipService.addVisit` to connect a person to a location with `VISITED`.

```ts
interface AddVisitPayload {
  personEntityId: string;
  locationEntityId: string;
  date?: string | Date;
  duration?: string;
  notes?: string;
  properties?: Record<string, unknown>;
}
```

**Response**
```json
{
  "success": true,
  "visit": {
    "relationshipId": "visit-uuid",
    "from": "person-uuid",
    "to": "location-uuid",
    "properties": {
      "date": "2024-01-15T00:00:00.000Z",
      "duration": "3 days"
    }
  }
}
```

---

### POST `/graph/connection`
Creates a social relationship via `RelationshipService.addSocialConnection`.

```ts
interface AddConnectionPayload {
  fromPersonId: string;
  toPersonId: string;
  connectionType: string; // e.g. 'FRIEND', 'WORKS_WITH'
  since?: string | Date;
  context?: string;
  strength?: number;
  properties?: Record<string, unknown>;
}
```

**Response**
```json
{
  "success": true,
  "connection": {
    "relationshipId": "conn-uuid",
    "from": "person-a",
    "to": "person-b",
    "type": "WORKS_WITH",
    "strength": 0.8
  }
}
```

---

### GET `/graph/context`
Returns the hydrated context from `UserContextService.getUserContextForLLM`.

```json
{
  "success": true,
  "context": {
    "currentUser": {
      "entityId": "person-uuid",
      "name": "John Doe",
      "username": "john",
      "properties": { "age": 42 }
    },
    "familyMembers": [
      {
        "entityId": "spouse-uuid",
        "name": "Jane Doe",
        "relationship": "SPOUSE",
        "age": 40,
        "properties": { "occupation": "Designer" }
      }
    ],
    "topPreferences": [
      {
        "entityId": "concept-uuid",
        "name": "Italian Cuisine",
        "type": "cuisine",
        "strength": 0.9,
        "relationship": "PREFERS"
      }
    ],
    "quickStats": {
      "totalEntities": 45,
      "totalPreferences": 12,
      "totalDislikes": 3,
      "familySize": 3
    }
  }
}
```

---

### GET `/graph/context/formatted`
Markdown-friendly presentation of the same context. If no context exists, the controller returns `success: false` with a message.

```json
{
  "success": true,
  "formatted": "# User Context\n\n## Current User\n- Name: John Doe\n..."
}
```

```json
{
  "success": false,
  "message": "User context not available"
}
```

---

### GET `/graph/data`
Full graph snapshot for the current user. Nodes & links are sourced from `PersonGraphService.getAllNodes` and `RelationshipService.getRelationships`.

```json
{
  "success": true,
  "data": {
    "nodes": [
      {
        "id": "person-uuid",
        "entity_id": "person-uuid",
        "entity_type": "Person",
        "name": "Jane Smith",
        "description": "Creative director",
        "properties": {
          "occupation": "Designer"
        }
      }
    ],
    "links": [
      {
        "id": "rel-uuid",
        "relationship_id": "rel-uuid",
        "source": "person-uuid",
        "target": "concept-uuid",
        "relationship_type": "PREFERS",
        "strength": 0.8,
        "properties": {}
      }
    ]
  }
}
```

---

### POST `/graph/node/delete`
Soft-deletes a node (`GraphUtilityService.softDeleteNode`).

```ts
interface DeleteNodePayload {
  entityId: string;
}
```

**Response**
```json
{
  "success": true,
  "message": "Node deleted successfully"
}
```

---

### POST `/graph/node/update`
Updates node metadata using `PersonGraphService.updateNode` (delegates to `GraphUtilityService`).

```ts
interface UpdateNodePayload {
  entityId: string;
  name?: string;
  description?: string;
  properties?: Record<string, unknown>;
}
```

**Response**
```json
{
  "success": true,
  "node": {
    "entityId": "person-uuid",
    "name": "Updated Name",
    "description": "Updated description",
    "properties": { "occupation": "Engineer" }
  }
}
```

---

### POST `/graph/relationship/delete`
Soft-deletes a relationship (`GraphUtilityService.softDeleteRelationship`).

```ts
interface DeleteRelationshipPayload {
  relationshipId: string;
}
```

**Response**
```json
{
  "success": true,
  "message": "Relationship deleted successfully"
}
```

---

## Error Shape

When validation fails or an exception is thrown, the API uses Nest's default error format:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request"
}
```

Expect `401` for missing/invalid tokens, `404` for missing entities, and `500` for unexpected server errors.

---

## Implementation Notes

- `PersonGraphService`, `PreferenceService`, `LocationGraphService`, and `RelationshipService`
  wrap low-level operations in `GraphUtilityService`, so requests map directly to graph
  nodes and relationships without raw SQL.
- `UserContextService` composes graph data to produce rich context objects and
  formatted markdown prompts for LLM pre-hydration.
- Bidirectional family/social relationships are inferred automatically for types such as
  `SPOUSE`, `SIBLING_OF`, and `FRIEND`.
- Preference endpoints create or reuse `Concept` nodes and connect them with
  `PREFERS`/`DISLIKES` edges, keeping strength values in the 0–1 range.

---

## TypeScript Reference Types

```ts
export type {
  AddPersonPayload,
  AddPersonResponse,
  AddFamilyPayload,
  AddFamilyResponse,
  AddPreferencePayload,
  AddPreferenceResponse,
  AddPreferencesPayload,
  AddPreferencesResponse,
  AddLocationPayload,
  AddLocationResponse,
  AddVisitPayload,
  AddVisitResponse,
  AddConnectionPayload,
  AddConnectionResponse,
  GetContextResponse,
  GetFormattedContextResponse,
  GetGraphDataResponse,
  DeleteNodePayload,
  DeleteNodeResponse,
  UpdateNodePayload,
  UpdateNodeResponse,
  DeleteRelationshipPayload,
  DeleteRelationshipResponse,
} from '@/types/graph'; // Example re-export if you centralize types
```

Adapt these interfaces in your own services or API clients to maintain alignment with the
controller contract.
