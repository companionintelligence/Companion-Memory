# Saved searches: sharing & full-filter capture

> Personal database feature in CI-Server's web app. A saved search now (a) captures the
> **full** explorer state — not just query/types/tags — and (b) can be **shared** via a
> signed-in capability link that runs the search *as the owner*.

![Saved-search share & edit flow](images/saved-search-flow.svg)

> User-facing docs (with this same set of screenshots): see the **Companion Memory** page
> at [docs.ci.computer](https://docs.ci.computer/docs/apps-available/first-party-apps/companion-memory-server)
> (`src/content/docs/apps-available/first-party-apps/companion-memory-server.mdx` in the
> CI-Docs repo — the older `/docs/first-party-apps/digital-memory-server` slug still 301s
> there via `public/_redirects`). The
> screenshots below are captured from the CI-Server Storybook stories via
> `CI-Docs/scripts/capture-component-screenshots.sh` and committed to both repos so they
> stay in sync — except the share modal, which is deliberately not committed here (see §3).

## Screenshots / live UI

All the rendered UI lives as **Storybook** stories under `frontend/apps/web/src/pages/SavedSearchesPage/*.stories.tsx`
(the reproducible source). To view them live or re-capture screenshots:

```bash
yarn workspace @ci/fe-web storybook   # http://localhost:6006
# Then either browse the "Saved Search" group, or:
bash ../CI-Docs/scripts/capture-component-screenshots.sh
```

> **Heads-up (2026-08-19):** the capture script still asks for the story ids
> `saved-search-card--shared-and-filtered` and `saved-search-card--plain`
> (`CI-Docs/scripts/capture-component-screenshots.sh:28-29`). `SavedSearch.stories.tsx` is
> titled `Saved Search/Row` now, so those two ids resolve to nothing — they are
> `saved-search-row--shared-and-filtered` and `saved-search-row--plain`. The other four
> lines are still correct. Fix the script before re-capturing.

---

## Flow A — share a saved search

### 1. Build a search

In the **Memory Explorer** (`/memory/events`), type a query in the header's global search
box and add any filters. On the Explorer these render inline rather than behind an
Advanced panel: the **What** category bar plus When (date range or a rolling preset), How
(event types), who (people), where (places), source (connectors), **Has a location**,
**Semantic** and Sort, with the active ones shown as chips in the drop area. All of it is
captured by a save — not just the query. (The **Advanced** toggle still exists, but only
for the header search dropdown on non-`/memory` pages.)

### 2. Save & share  ·  _toolbar_

Click **Save** in the explorer toolbar. The dialog has three actions:
**Cancel**, **Save**, and **Save & share**. **Save & share** creates the saved search and
immediately opens the share modal on it — no trip to the Saved Searches page.

### 3. Share modal  ·  story `saved-search-share-modal--link-shared`

> No screenshot here, on purpose: a capture of this story prints the Storybook dev origin into the
> link and embed fields (`http://localhost:6006/shared/…`, because `shareUrl` in `shareLink.ts`
> defaults to the page origin — `getWebOrigin()`, which inside the iOS/Android apps is the
> Memory server they are paired with, never their own `capacitor://localhost`). Open the
> story live instead.

- **Visibility** toggle: _Not shared_ / _Link shared_.
- Turning on **Link shared** mints an unguessable token and shows the **capability link**
  (`/shared/<token>`), **social** buttons (Email / Message / Facebook / LinkedIn), and an
  **iframe embed** snippet — each copyable.
- Turning sharing off, then on again, **rotates** the token (old links die).

### 4–5. Recipient opens the link → read-only viewer  ·  route `/shared/:token`

A **signed-in** recipient opens the link and sees a read-only explorer (List / Gallery /
Map; responsive). The search runs **as the owner** — the token authorises the owner's
stored definition only; the viewer cannot widen it. Media (photo/video thumbnails) resolves
under the owner so shared galleries actually render. If the recipient isn't signed in,
login (incl. CI-Portal **OIDC**) returns them to the shared link afterward.

---

## Flow B — manage & edit a saved search

### Saved Searches row  ·  story `saved-search-row--shared-and-filtered`

![Saved-search card](images/saved-search/saved-search-card.jpg)

Each row shows a **“Shared”** badge when public and the **active filter dimensions**
spelled out (`Who · Where · When · How · Source · Semantic`, from
`activeFilterDimensions` in `SavedSearch.tsx`) so the captured filters are visible at a
glance. Buttons: **Edit · Share · Delete** — the Share button and the Shared badge only
render when the `shared.search` flag is on.

### Edit modal + Filters editor  ·  stories `saved-search-edit-modal--with-filters`, `saved-search-filters-editor--populated`

![Edit modal](images/saved-search/edit-modal-filters.jpg)

![Filters editor](images/saved-search/filters-editor.jpg)

The Edit modal now has a **Filters** section (below Tags) with a full editor:

| Dimension            | Control                                   |
| -------------------- | ----------------------------------------- |
| Who / Where / How / Source | removable chips + free-text add     |
| When                 | From / To date pickers                    |
| Sort                 | preset dropdown (Newest, Name A–Z, …)     |
| Located only / Semantic | toggles                                |

Editing here keeps the saved search in sync everywhere it runs — the explorer restore
**and** a shared link.

---

## How it works

### Capture & restore (the explorer ↔ a saved search)

- **Capture:** the toolbar's `buildSavedSearchFilters(URLSearchParams)` reads the explorer's
  `?from/?to`, `?when` (a rolling preset, stored as `datePreset` instead of a frozen
  range), `?eventTypes`, `?connectors`, `?people`, `?places`, `?hasLocation`, `?semantic`,
  `?sortBy/?sortOrder` into a `filters` object. The Edit modal edits the same shape via
  `SavedSearchFiltersEditor`.
- **Storage:** a `filters JSONB` column on `ci.saved_searches`
  (migration `20260628130000_add_saved_search_filters.sql`).
- **Restore:** `DesktopMemoryPage` writes those `filters` back into the explorer URL params
  when a saved search is opened (`/memory/events?saved_search=<id>`). The saved-search card
  still links to `/memory?saved_search=<id>`, which works because `/memory` redirects to
  `/memory/events` preserving the query string.

### Sharing (signed-in capability links)

- `ci.saved_searches` carries `is_public` + `share_token`
  (migration `20260702012521_add_saved_search_sharing.sql` — reissued from the colliding
  hand-stamped `20260628120000` — with a `CHECK` constraint binding the two).
- `setSavedSearchSharing` mints / rotates / clears the token (owner-scoped);
  `sharedSavedSearch(token)` returns the definition for the viewer **without** echoing the
  token back.
- A shared run goes through `SearchInput.shareToken` →
  `SearchResolver.runSharedSearch`, which loads the saved search, builds the **owner's**
  service context, and applies **only the owner's stored filters** (the viewer controls
  paging/sort only). `entityOwnerScope` makes a result node's media/relations/tags resolve
  under the node's owner so shared galleries render.
- Access is **signed-in users only** — the resolvers stay behind the auth guard; the token
  is not an anonymous surface. The whole surface is additionally gated by the
  `shared.search` feature flag, which has shipped **on by default** in
  `backend/apps/api/config/default.json` since 2026-08-08 (commit `23151975e`). With the
  flag off, `sharedSavedSearch(token)` resolves to `null` — indistinguishable from an
  unknown or revoked token — so the viewer shows "link unavailable".
  See the tenancy note in [`architecture.md`](architecture/architecture.md) §8 and the
  API-side description in
  [`docs/api/graphql.md` §2/§3.7](api/graphql.md#37-search--saved-searches).
- Schema: `ci.saved_searches` — see
  [`Database.md`](architecture/Database.md#connectors-auth-misc).

### The token is the invitation, not the authorization

Until `20260826151123_add_saved_search_share_consent.sql`, holding the token **was** the
whole of the authorization. Next to the ask path — which carries standing grants, a
disclosure ceiling, an expiry, a supersede chain and a durable audit row per disclosure —
the share path carried none of it. Five things were inexpressible:

| | Ask path | Share path (before) |
| --- | --- | --- |
| Who read my memory? | `ci.ask_audit.asker_user_id` | nobody knew — every holder was the same anonymous principal |
| Revoke **one** reader | revoke their grant | impossible; `setSharing(false)` cut off everyone |
| "How many, not which" | `scope.maxDisclosure` | inexpressible — full result nodes or nothing |
| Link lapses on its own | `ask_grants.expires_at` | never; it stood until the owner remembered |
| Written down | `ci.ask_audit` | **nothing** — the one disclosure surface absent from Disclosure History |

The token keeps the job it is good at (travelling in a URL) and is now **exchanged, on
first use by a signed-in reader, for a `ci.ask_grants` row naming that reader and that
saved search** — the standing, owner-visible, individually revocable handle the token could
never be. It is the same object the Grant Manager already lists and revokes. See
[`asks-system-guide.md` §2](asks-system-guide.md) for the consent layer itself.

What that buys, concretely:

- **A ceiling.** `saved_searches.share_max_disclosure` holds a `DISCLOSURE_RUNGS` rung, and
  `applySearchCeiling` (`domains/asks/searchCeiling.ts`) clamps the result connection to it
  — items, magnitude, tag facets and the right to page beyond the window, as four
  independent axes. NULL means *this share declares no ceiling*, which is what every link
  created before the column existed carries and why they keep disclosing exactly what they
  always did. NULL is **not** `full`: absent and `full` are different statements and only
  one of them is something the owner said.
- **An expiry.** `share_expires_at`, enforced *in SQL* inside `findByShareToken`, so a
  lapsed link is indistinguishable from an unknown one — there is no branch that could
  report which it was.
- **Per-reader revocation that sticks.** A grant the owner revoked is a **standing denial**,
  not a gap the next read mints a replacement into. Without that rule "revoke Dana" would
  last exactly until Dana hit refresh. A `superseded` grant is excluded — that reason marks
  a row replaced by `GrantService.supersede`, which leaves a live successor.
- **The capture-at-consent-time rule.** The ceiling is stamped on the reader's grant when it
  is minted and then combined with the share's live ceiling by `narrowestRung`, never
  replaced by it. Read only the live value and an owner who clears the share posture makes
  every existing reader's answer **grow** — the same defect
  `20260821010000_add_ask_disclosure_ceiling` exists to prevent on the ask path.
- **An audit row per read**, with `disclosed_entities` (what crossed, post-ceiling) kept
  apart from `backing_entities` (what the box read to produce it). One row per **read**, not
  per reader: that access exists is a fact about the grant; that it was *used*, when, and
  how much crossed is what the audit is for.

Four outcomes share one response — an unknown token, a revoked link, a lapsed link, and a
reader the owner specifically revoked all return the same empty connection. Which of the
four it was is a fact about the owner's posture, and a refused reader does not need it in
order to be refused. (Same rule as `PEER_ASK_PENDING` on the federated ask path.)

**Not in this change:** a `review`-mode share (first open needs the owner's approval) and
the UI for setting a ceiling or an expiry. `setSavedSearchSharing` accepts `maxDisclosure`
and `expiresAt` today; `ShareSavedSearchModal` does not send them yet, so every share
created through the product still has the pre-existing posture.

### Where the code lives

| Area | Path |
| ---- | ---- |
| Filter capture (pure) | `frontend/.../pages/MemoryPage/savedSearchFilters.ts` |
| Filter edit helpers (pure) | `frontend/.../pages/SavedSearchesPage/savedSearchFiltersEdit.ts` |
| Filter editor UI | `frontend/.../pages/SavedSearchesPage/SavedSearchFiltersEditor.tsx` |
| Share modal | `frontend/.../pages/SavedSearchesPage/ShareSavedSearchModal.tsx` |
| Read-only viewer | `frontend/.../pages/SharedSearchPage/SharedSearchPage.tsx` |
| Sharing + filters backend | `backend/.../files/services/SavedSearchService.ts`, `backend/.../graphql/resolvers/{SavedSearchResolver,SearchResolver}.ts` |

### Tests

- Backend (jest): `SavedSearchService` (mint/rotate/clear, posture stamping, owner scoping,
  token lookup, lapse-in-SQL, create/update **filters**), `SavedSearchResolver` (rung
  parsing, past-expiry rejection), `SearchResolver.runSharedSearch` (filter-stripping /
  run-as-owner / **filters applied** / bad-token / consent-refusal / ceiling clamping /
  disclosed-vs-backing audit), `SharedSearchConsentService` (mint, reuse, standing denial,
  supersede, lapse, ceiling algebra, mint race), and the OIDC open-redirect guard.
- `searchCeiling.spec.ts` carries the **monotonicity property test**: walking the ladder,
  every rung must disclose a superset of the one below and strictly more on at least one
  axis. That is what makes threat-model **D2** — `clampAvailability` pointing `redacted` at
  the same branch as `full`, so a ceiling the owner picked restricted nothing —
  unrepeatable on this surface. A per-rung unit test cannot catch it, because the defect
  lives in the *relationship* between two rungs; mutation-verified by re-pointing `redacted`
  at `full` (2 tests fail) and reverting.
- Frontend (vitest): the pure builders — `shareLink`, `savedSearchFilters` (capture),
  `savedSearchFiltersEdit` (edit transforms).
- Stories double as render smoke-tests for the new UI.
