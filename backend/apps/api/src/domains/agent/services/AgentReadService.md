# AgentReadService.ts

## Purpose
Builds the compact, read-only payloads for the external `/agent/v1` API. It sits above the existing domain services and reshapes their richer internal models into small agent-oriented DTOs.

## Components

### `getCapabilities`
- **Does**: Returns the public tool/resource catalog plus a GraphQL breadth summary
- **Interacts with**: `AgentOwnerService`, generated GraphQL schema file

### `getUserContext`
- **Does**: Returns the owner context object and a markdown rendering
- **Interacts with**: `UserContextService`

### `searchMemory`
- **Does**: Runs bounded search and resolves index hits into compact summaries
- **Interacts with**: `SearchService`, entity services across memory/conversations/files/notes
- **Rationale**: External agents need enough text to decide follow-up calls without paying GraphQL-size costs

### `readEntityGraph`
- **Does**: Resolves seed entities and returns a bounded graph neighborhood
- **Interacts with**: `GraphQueryService`

### `getRecentActivity`, `getThread`, `getDocument`
- **Does**: Provides the remaining v1 retrieval surfaces with hard size limits
- **Interacts with**: `SummaryService`, `ActionService`, `MessageService`, `ThreadService`, `FileService`

## Contracts

| Dependent | Expects | Breaking changes |
|-----------|---------|------------------|
| `AgentController` | Methods throw HTTP exceptions on missing resources and return compact DTOs | Renaming methods or DTO fields |
| `backend/apps/mcp` | Payloads remain small and predictable | Expanding responses back toward GraphQL-sized shapes |

## Notes
- `getDocument` only inlines text for directly text-like files; PDFs and binary documents intentionally return `text: null` in v1.
- Owner resolution metadata is surfaced through capabilities to make fallback behavior visible.
