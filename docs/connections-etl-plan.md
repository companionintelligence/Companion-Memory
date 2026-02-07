# Connections ETL Refactor Plan

## Purpose

Refactor connections syncing into a clean, declarative ETL pipeline that makes it easy to:

- Add new API providers without copying client boilerplate.
- Keep extract/transform/load responsibilities explicit.
- Provide provider-level mock APIs and deterministic integration tests.
- Keep current production behavior intact while we migrate.

This plan is intentionally implementation-first for Wave 1 (Google, Microsoft, Facebook), then scales to all planned integrations listed on the Connections page.

## Current State Snapshot

- Implemented provider clients: Google, Microsoft, Facebook.
- Provider records seeded in DB: Google, Microsoft, Facebook.
- ETL currently extracts into `ci.api_log` and promotion workers transform/load from `api_log.scope`.
- Connections UI already advertises additional providers as "Coming soon."

## Design Principles

- Declarative over hardcoded: provider/source definitions should live in a catalog.
- Backward compatible first: Wave 1 keeps existing sync semantics and data shape.
- Stream-level state: every endpoint stream has independent checkpoint state.
- Testability by default: every provider has mock fixtures and test env key conventions.
- Observability: every ETL stage emits structured logs and stage-level metrics.

## Target Architecture

### 1. Provider Catalog (declarative registry)

Single catalog entry per provider:

- Provider identity (`key`, optional persisted provider UUID).
- Lifecycle status (`active` or `planned`).
- Auth definition (`oauth2`, `oauth1`, `apikey`, `bearer`, etc.).
- Stream definitions (endpoint scope, cursor strategy, domain).
- Mock/test key conventions and runtime modes (`mock`, `sandbox`, `live`).

This is inspired by LifeScope's `fixtures/providers` + `fixtures/maps` split, with type-safe TS definitions and runtime validation.

### 2. ETL Pipeline Contract

Each provider adapter implements:

- `extract`: fetch raw records from remote APIs.
- `transform`: map extracted records into canonical ETL records.
- `load`: persist canonical records and/or enqueue domain-specific promotion jobs.

Pipeline orchestrator handles:

- Shared execution context.
- Stage timing/metrics.
- Retry/failure boundaries.
- Summarized per-run result object.

### 3. State Model

- Keep existing `connections.sync_state` for compatibility.
- Standardize nested stream checkpoints under named stream keys.
- Support cursor formats: token, timestamp, URL, or composite.

### 4. Promotion Compatibility

- Preserve existing promotion scopes and event routing for current providers.
- Future providers should register promotion routes declaratively (scope -> event -> handler).

## Integration Inventory

### Active (implemented)

1. Google
- Streams: Gmail, Calendar, Drive, Contacts, YouTube
- Auth: OAuth2
- Wave: 1

2. Microsoft
- Streams: Outlook Mail, Calendar, OneDrive
- Auth: OAuth2
- Wave: 1

3. Facebook
- Streams: Profile, Posts, Photos, Videos, Friends, Likes
- Auth: OAuth2
- Wave: 1

### Planned from Connections UI

1. Discord
- Initial streams: guilds, channels, message history
- Auth: OAuth2
- Wave: 3

2. GitHub
- Initial streams: user events, repos, PRs/issues metadata
- Auth: OAuth2 / PAT
- Wave: 2

3. Instagram
- Initial streams: media posts, comments, profile metadata
- Auth: OAuth2
- Wave: 3

4. Shopify
- Initial streams: orders, products, customers
- Auth: OAuth2 / API key
- Wave: 4

5. Signal
- Initial streams: messages metadata (if API constraints allow)
- Auth: TBD
- Wave: 4

6. Slack
- Initial streams: conversations, messages, files, users
- Auth: OAuth2
- Wave: 2

7. Spotify
- Initial streams: saved tracks, playlists, recent plays
- Auth: OAuth2
- Wave: 2

8. Steam
- Initial streams: owned games, achievements
- Auth: OpenID / API key
- Wave: 4

9. X
- Initial streams: tweets, mentions, user profile
- Auth: OAuth2
- Wave: 3

10. LinkedIn
- Initial streams: profile, posts, reactions (policy-dependent)
- Auth: OAuth2
- Wave: 3

11. Notion
- Initial streams: pages, databases, blocks
- Auth: OAuth2 / internal integration token
- Wave: 3

12. Twitch
- Initial streams: follows, channel activity, clips metadata
- Auth: OAuth2
- Wave: 3

13. Reddit
- Initial streams: comments, submissions, saved/upvoted content
- Auth: OAuth2
- Wave: 2

14. Dropbox
- Initial streams: file metadata changes, previews
- Auth: OAuth2
- Wave: 2

### Backlog Inspired by Legacy LifeScope

1. Pinterest
2. Lyft
3. Uber

These are not currently in the Connections UI, but map cleanly to the same provider catalog model.

## Mock API and Test Key Standard

Per-provider env conventions:

- `PROVIDER_<NAME>_MODE=mock|sandbox|live`
- `PROVIDER_<NAME>_CLIENT_ID`
- `PROVIDER_<NAME>_CLIENT_SECRET`
- `PROVIDER_<NAME>_TEST_ACCESS_TOKEN`
- `PROVIDER_<NAME>_TEST_REFRESH_TOKEN`
- `PROVIDER_<NAME>_MOCK_BASE_URL`

Where `<NAME>` uses uppercase provider key (example: `GOOGLE`, `SLACK`, `GITHUB`).

## Testing Strategy

### Unit

- Stream extraction params and pagination behavior.
- Cursor merge/update behavior.
- Transform mapping into canonical ETL records.

### Contract

- Provider catalog schema validation.
- Stream definition validation (required scopes, cursor strategy).

### Integration

- Provider-local mock API server with fixture payloads.
- End-to-end ETL run against mock mode with deterministic assertions.

### CI Smoke

- Live/sandbox smoke checks for selected providers (wave-gated).

## Rollout Plan

### Wave 1: Foundation + Migration (Google/Microsoft/Facebook)

- Add provider catalog scaffolding for active and planned providers.
- Add ETL pipeline interfaces/orchestrator scaffolding.
- Keep existing sync behavior unchanged.
- Add tests for catalog integrity and provider env key resolution.

### Wave 2: High-value Productivity/Social APIs

- GitHub, Slack, Dropbox, Reddit, Spotify.
- Add provider-specific mock servers + contract tests.

### Wave 3: Broader Social/Productivity APIs

- Discord, Notion, LinkedIn, Twitch, X, Instagram.

### Wave 4: Higher-policy/complexity APIs

- Shopify, Steam, Signal.

## Acceptance Criteria for Wave 1

- Provider catalog exists and includes all active + planned integrations.
- Active provider runtime remains unchanged for users.
- ETL pipeline contracts are in place for next migration steps.
- Targeted tests validate catalog and provider env conventions.

## Connector Discovery Plan

### Goal

Continuously discover and prioritize new connectors that increase memory quality and user retention.

### Discovery Inputs

1. In-product demand signals
- Track `connect` page card clicks on disabled providers.
- Track failed manual import attempts and user support requests.

2. Existing data graph gaps
- Audit missing domains in user graphs (finance, travel, health, commerce, smart home, developer tools).
- Prioritize connectors that fill high-frequency empty entities/relationships.

3. External ecosystem scan
- Quarterly scan of official API catalogs and provider changelogs.
- Track API policy changes that affect existing or planned integrations.

### Selection Rubric

Score each candidate 1-5 in:

1. User value density (daily/weekly relevance)
2. API reliability and long-term policy stability
3. Security/compliance complexity
4. ETL complexity (pagination, rate limits, backfills)
5. Promotion readiness (can data map cleanly to canonical entities)

Prioritize highest total score with implementation feasibility.

### Implementation Pipeline

1. Add catalog entry (`planned`) with auth/env template and stream list.
2. Add mock payload fixtures and adapter classification tests.
3. Implement connector extraction and pipeline adapter.
4. Add transform/load assertions in integration tests.
5. Launch behind feature flag to a small cohort before broad rollout.

### Cadence

- Weekly triage of candidate queue.
- Monthly connector roadmap refresh.
- Quarterly pruning of stale or deprecated candidates.

### Candidate Queue (Next Discovery Pass)

1. Developer and productivity
- GitLab, Linear, Jira, Asana.

2. Personal finance and commerce
- Plaid, Stripe, PayPal, Amazon order history.

3. Travel and mobility
- Delta/United trip history, Airbnb, Google Maps timeline exports.

4. Health and wearables
- Apple Health exports, Oura, Garmin, Fitbit.

5. Media and communication
- Apple Music, WhatsApp export ingestion, Substack, Pocket.
