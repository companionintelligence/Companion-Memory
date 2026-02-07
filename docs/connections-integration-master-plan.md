# Connections Integration Master Plan

## Goal

Complete and productionize Connections integrations for:

1. Current active providers:
- Google
- Microsoft
- Facebook

2. Current planned providers on Connect page:
- Discord
- GitHub
- Instagram
- Shopify
- Signal
- Slack
- Spotify
- Steam
- X
- LinkedIn
- Reddit
- Notion
- Dropbox

3. Newly requested providers:
- Evernote
- Garmin
- WHOOP
- Fitbit
- monday.com
- HubSpot
- Jira
- Xero
- QuickBooks
- Box
- Plaid

## Current Readiness Review

1. Already implemented end-to-end:
- Google
- Microsoft
- Facebook

2. Cataloged and visible as coming soon, but not yet connectable:
- Discord, GitHub, Instagram, Shopify, Signal, Slack, Spotify, Steam, X, LinkedIn, Notion, Twitch, Reddit, Dropbox

3. Missing from catalog and Connect page:
- Evernote, Garmin, WHOOP, Fitbit, monday.com, HubSpot, Jira, Xero, QuickBooks, Box, Plaid

4. Architecture gaps to close first:
- Connect page is hardcoded and can drift from provider catalog.
- DB `ci.providers` seed only contains Google, Microsoft, Facebook.
- `ClientFactory` only registers 3 provider clients.
- No shared mock API harness for provider contract testing yet.

## Non-Negotiable Architecture Before Expanding

1. Single source of truth
- Provider catalog drives both backend/provider metadata and Connect page card rendering.
- Add UI metadata to catalog (logo path, accent colors, description, lifecycle badge, category).

2. Provider runtime modes
- Standard env mode per provider:
  - `PROVIDER_<KEY>_MODE=mock|sandbox|live`
  - `PROVIDER_<KEY>_CLIENT_ID`
  - `PROVIDER_<KEY>_CLIENT_SECRET`
  - `PROVIDER_<KEY>_TEST_ACCESS_TOKEN`
  - `PROVIDER_<KEY>_TEST_REFRESH_TOKEN`
  - `PROVIDER_<KEY>_MOCK_BASE_URL`

3. ETL contract consistency
- Every provider has:
  - stream definitions
  - extractor
  - transform mapping
  - checkpoint cursor strategy
  - promotion scope mapping

4. Test layers required per provider
- Unit tests: extraction pagination + cursor merge.
- Contract tests: response schema fixture validation.
- Integration tests: mock server end-to-end sync.
- Optional smoke tests: sandbox/live run when keys are present.

## Connector API Plan and Priority

## Tier 1 (Implement first: high value, strong API viability)

1. GitHub
- Auth: OAuth2 (and optional PAT fallback).
- Streams: events, repos, PRs, issues, commits.
- Notes: stable API, clear pagination.

2. Slack
- Auth: OAuth2.
- Streams: channels, DMs, messages, files, users.
- Notes: good workspace value, requires bot/user scopes planning.

3. Reddit
- Auth: OAuth2.
- Streams: comments, submissions, saved/upvoted items.

4. Notion
- Auth: OAuth2 (or internal integration token in controlled mode).
- Streams: pages, databases, blocks.

5. Dropbox
- Auth: OAuth2.
- Streams: file metadata changes, folder deltas.

6. Box
- Auth: OAuth2.
- Streams: files, folders, comments, collaborations.

7. Jira
- Auth: OAuth2.
- Streams: issues, projects, comments, worklogs.

8. HubSpot
- Auth: OAuth2.
- Streams: contacts, companies, deals, activities.

9. QuickBooks
- Auth: OAuth2.
- Streams: customers, invoices, payments, expenses.

10. Xero
- Auth: OAuth2.
- Streams: contacts, invoices, payments, bank transactions.

11. Plaid
- Auth: Link + access token exchange.
- Streams: accounts, transactions, balances.

12. monday.com
- Auth: OAuth2.
- Streams: boards, items, updates.

## Tier 2 (Implement next: good value, moderate complexity/policy)

1. Discord
- Streams: guilds, channels, messages.

2. Spotify
- Streams: saved tracks, playlists, recent plays.

3. Shopify
- Streams: orders, products, customers.

4. Instagram
- Streams: media, captions, comments (policy-limited).

5. Steam
- Streams: owned games, achievements.

6. Fitbit
- Streams: profile, activity summaries, sleep, heart-rate aggregates.

7. Evernote
- Streams: notes, notebooks, tags.

## Tier 3 (Policy-restricted/high gating; implement with fallback plan)

1. X
- Risk: API tier limitations and commercial constraints.
- Fallback: import from user export bundle when API scope is insufficient.

2. LinkedIn
- Risk: restricted consumer feed/activity access.
- Fallback: profile + limited activity scopes, optional export import.

3. Signal
- Risk: no broad public API for message sync.
- Fallback: user-provided export ingestion and metadata-only model.

4. Garmin
- Risk: partner/developer approval path.
- Fallback: user export ingestion first.

5. WHOOP
- Risk: app approval and access review.
- Fallback: delayed live integration; mock + contract first.

## Delivery Waves

## Wave 0: Foundation (must complete first)

1. Catalog and Connect page unification
- Refactor Connect page to render service cards from provider catalog payload.
- Remove hardcoded service integration list in UI.

2. Provider persistence bootstrap
- Add migration to seed all Tier 1 + Tier 2 + Tier 3 providers in `ci.providers`.
- Include endpoints metadata and basic theme/logo fields.

3. ClientFactory refactor
- Replace static map wiring with provider client registry.
- Allow providers without live client to run in `mock` mode safely.

4. Mock harness
- Build provider mock API router + fixture loader.
- Fixtures organized by provider + stream + pagination case.

## Wave 1: Tier 1 implementation and tests

1. Implement connectors:
- GitHub, Slack, Reddit, Notion, Dropbox, Box, Jira, HubSpot, QuickBooks, Xero, Plaid, monday.com

2. Per connector required artifacts:
- provider client
- endpoint scope map
- extraction methods
- sync response normalization
- ETL adapter classification tests
- mock fixtures + integration tests

3. Exit criteria:
- All Tier 1 connectors can run `mock` mode in CI.
- Live smoke tests are key-gated and pass when credentials exist.

## Wave 2: Tier 2 implementation and tests

1. Implement:
- Discord, Spotify, Shopify, Instagram, Steam, Fitbit, Evernote

2. Exit criteria:
- Same as Wave 1; policy-limited fields explicitly documented.

## Wave 3: Tier 3 constrained connectors

1. Implement:
- X, LinkedIn, Signal, Garmin, WHOOP

2. Build dual-path strategy per connector:
- API mode where allowed.
- Export-ingestion mode where API is blocked or scope-limited.

3. Exit criteria:
- At minimum, mock + export ingestion path operational.
- Live API path enabled only when policy approval is complete.

## Connect Page Completion Plan

1. Add missing requested providers to catalog and UI metadata:
- Evernote, Garmin, WHOOP, Fitbit, monday.com, HubSpot, Jira, Xero, QuickBooks, Box, Plaid

2. Add branding assets for missing logos:
- Add `/public/branding/<provider>/logo.svg` for each new provider.

3. Render lifecycle badges from catalog:
- `Active`
- `Planned`
- `Restricted` (for policy-limited connectors)

4. Enable click-to-connect only when backend provider + client mode is available.

## API Test Plan (No Keys Yet)

1. Immediate (before key collection)
- Run all provider integration tests in `mock` mode.
- CI blocks merges if mock contract tests fail.

2. After test keys arrive
- Add sandbox/live smoke suite:
  - one short sync per connector
  - verify auth exchange
  - verify at least one record extracted
  - verify checkpoint update

3. Key onboarding checklist
- Store keys in env/secret manager.
- Set `PROVIDER_<KEY>_MODE=sandbox` first.
- Run smoke test.
- Promote to `live` per provider after verification.

## Definition of Done per Connector

1. Provider exists in catalog and DB seed migration.
2. Connect page card rendered from catalog metadata.
3. Auth flow functional in mock mode.
4. Extract/transform/load pipeline implemented.
5. Mock fixtures cover pagination, empty responses, and error responses.
6. Contract + integration tests pass.
7. Live smoke test passes once keys are available.
8. Runbook docs include scopes, quotas, and known policy limits.

## Execution Order Recommendation

1. Finish Wave 0.
2. Build Tier 1 connectors to full testable state.
3. Build Tier 2 connectors.
4. Complete Tier 3 with fallback/export paths.
5. Collect test API keys and run gated smoke tests.
