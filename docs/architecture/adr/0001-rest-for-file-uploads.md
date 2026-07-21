# ADR-0001: REST for Binary File Uploads, GraphQL for Everything Else

| Field         | Value                    |
|---------------|--------------------------|
| **Status**    | Accepted                 |
| **Date**      | 2026-04-08               |
| **Author(s)** | @mltq                    |
| **Reviewers** | TBD                      |

## Context

CI-Server's API layer uses GraphQL (Apollo Server v5 via `@nestjs/apollo`) as its primary interface. The original intent was to expose all client-facing operations through a single GraphQL endpoint, giving clients a consistent, typed, self-documenting API surface.

When implementing the async document parsing pipeline, the question arose: should the file upload step also go through GraphQL?

GraphQL multipart file uploads (the [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec)) were supported by Apollo Server v2 and v3 via `apollo-upload-server`. **Apollo Server v4 removed this support entirely**, and Apollo Server v5 (in use here) has not restored it. The Apollo team's stated position is that binary upload is outside the GraphQL specification and should be handled by purpose-built HTTP mechanisms.

Attempting to re-add multipart support on top of Apollo v5 requires intercepting and rewriting the Apollo request pipeline before the server sees the request, introducing a brittle middleware shim that is incompatible with Apollo's built-in body parsing, CSRF protection, and request lifecycle hooks. Community workarounds (`graphql-upload`, `graphql-upload-ts`) have documented reliability issues at this version boundary and are unmaintained relative to Apollo's current release cadence.

CI-Server already has a working multipart upload endpoint (`POST /files/upload`) that handles deduplication, S3/Minio storage, and post-upload event emission. Clients using that endpoint already get everything they need: a file ID they can immediately use in subsequent GraphQL queries.

## Decision

Binary file uploads use the existing REST endpoint (`POST /files/upload`). All other file operations — querying files, reading parse status, listing, and future mutations that operate on already-stored files — are exposed through GraphQL.

The boundary rule is: **if the request body is primarily binary bytes, use REST; if it is structured data, use GraphQL.**

Parse status is surfaced on `FileType` in the GraphQL schema (`parseStatus`, `parseError`, `parsedAt`), so clients that upload via REST can immediately switch to GraphQL to poll or display progress without any additional REST calls.

## Alternatives Considered

### Option A — GraphQL multipart upload via `graphql-upload-ts`

Add the `graphql-upload-ts` shim to intercept multipart requests before Apollo processes them.

Not selected because: the shim patches Apollo internals that change between minor releases, the package is not maintained against Apollo v5, and it introduces a failure mode (upload succeeds at the HTTP layer but Apollo's request context is missing) that is difficult to detect and handle cleanly.

### Option B — Base64-encoded file content as a GraphQL scalar

Accept file bytes as a `String` (base64) in a GraphQL mutation input.

Not selected because: base64 adds approximately 33% payload overhead, breaks standard browser `File` and `Blob` APIs that clients use to construct uploads, and makes the upload path meaningfully slower for large documents (PDFs, DOCX) which are the primary use case for the parsing pipeline.

### Option C — Presigned URL flow (upload direct to object storage)

Generate a presigned S3/Minio URL via GraphQL, have the client upload directly to object storage, then call a GraphQL mutation to register the file.

Not selected for V1 because: it introduces a three-step client flow (request URL → upload to S3 → register), requires the client to handle object storage errors directly, and adds complexity that is not justified until upload volume or file sizes make the proxied path a bottleneck. This remains the preferred direction if CI-Server ever needs to serve many concurrent large uploads.

## Consequences

### Benefits

- No dependency on unmaintained shim libraries.
- Upload path is stable against Apollo version upgrades.
- Clients get a clean separation: REST for the bytes, GraphQL for everything about the file after it exists.
- Parse status is fully observable via GraphQL without additional REST polling endpoints.
- The REST upload endpoint already handles deduplication, hash checking, and event emission — no parallel implementation needed.

### Risks & Trade-offs

- Clients must speak both REST and GraphQL. For a fully GraphQL-native client SDK this is a minor friction point.
- The "all GraphQL" goal is not met for uploads. This should be explicitly communicated to frontend and applet teams so they do not build around an expected upload mutation.
- If Apollo ever restores native multipart support (unlikely given their stated direction), this decision should be revisited.

### Migration / Adoption

No migration is required. The REST endpoint has always existed; this ADR formalizes its role as the canonical upload path. Applets and frontends should:

1. Upload file bytes to `POST /files/upload` (multipart form data, field name `files`, `Authorization` header required).
2. Use the returned `id` in GraphQL queries: `file(id: $id) { parseStatus parseError parsedAt }`.

## References

- [Apollo Server v4 migration: uploads removed](https://www.apollographql.com/docs/apollo-server/migration/#file-uploads)
- [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec)
- [Async Document Parsing Proposal](../../prd/CI-Server/Async%20Doc%20Parsing/Proposal.md)
- [Async Document Parsing Spec](../../prd/CI-Server/Async%20Doc%20Parsing/Spec.md)
