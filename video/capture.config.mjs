/**
 * Capture stage for Companion Memory (CI-Server).
 *
 * The stage is the repo's OWN full-stack e2e stack, not a second invention:
 *
 *   yarn e2e            # playwright.e2e.config.ts webServer boots
 *                       #   @ci/be-api  on :3030
 *                       #   @ci/fe-web  on :5173 (Vite proxies /api -> :3030)
 *
 * Playwright's `webServer` only boots those two node processes. The database
 * underneath has to already exist, be migrated and be seeded — see
 * .github/workflows/e2e.yml, which is the authoritative recipe:
 *
 *   cp .env.default .env
 *   make distribute-license
 *   docker build -f infrastructure/database/Dockerfile       -t ci/database:latest       infrastructure/database
 *   docker build -f infrastructure/setup-database/Dockerfile -t ci/setup-database:latest infrastructure/setup-database
 *   docker compose -f docker-compose.yml -f docker-compose.local.yml --profile local up -d database setup-database
 *   yarn workspace @ci/be-api migrate                    # ~147 dbmate migrations
 *   cd backend/apps/api && yarn run exec -- scripts/seed-database/main.ts
 *
 * WITHOUT THE SEED EVERY SCREEN IN THIS STORYBOARD IS AN EMPTY STATE.
 *
 * ── Authentication ───────────────────────────────────────────────────────────
 * Every interesting route is behind `ProtectedRoute`, so the capture context is
 * pre-authenticated here over HTTP using exactly the flow in
 * tests/e2e/global-setup.ts: GET /api/authenticate/csrf to mint the csrfToken
 * cookie, then POST /api/authenticate with the X-CSRF-Token header. Doing it in
 * `onContext` (rather than pointing `storageState` at playwright/.auth/user.json)
 * means capture does not depend on a prior `yarn e2e` run having left a fresh
 * state file behind.
 *
 * FIVE-PASS CAPTURE. `ci-video capture` creates ONE browser context per viewport
 * and shares it across every shot, so a single run is either logged in or logged
 * out — it cannot be both. This storyboard needs three different identities, in
 * five invocations:
 *
 *   npm run capture -- --only <the nine ids below>     # seeded jsmith
 *   VIDEO_LOGGED_OUT=1     npm run capture -- --only splash-screen,login-form
 *   VIDEO_FRESH_USER=1     npm run capture -- --only onboarding-focus
 *   VIDEO_FRESH_USER=1     npm run capture -- --only onboarding-connect
 *   VIDEO_FRESH_USER=1     npm run capture -- --only onboarding-trust
 *
 * EVERY pass is explicitly scoped, including the first. `ci-video capture` exits
 * 1 if any single shot fails (bin/ci-video.mjs cmdCapture), so a bare
 * `npm run capture` — which would try all fifteen shots as jsmith, five of them
 * structurally impossible for that identity — aborts the job before passes 2-5
 * run and leaves assets/shots/ empty. The authoritative list lives in
 * video/README.md's Quick start block; keep the two in step. (There is no
 * .github/workflows/video.yml any more — #1853 deleted it and moved the build
 * local; anything this file used to delegate to that job is spelled out here.)
 *
 * 1. AUTHENTICATED. The nine currently-filmable shots behind ProtectedRoute:
 *    feed-overview, memory-{list-view,detail-sheet,search-results,graph-view},
 *    people-directory, insights-list, insight-detail-view, connect-providers.
 *    NOT `/`, `/login` or `/onboarding` — see below. NOT memory-map-view
 *    either: it is a tenth ProtectedRoute shot but the seed cannot populate it,
 *    so it is deliberately left uncaptured — see hazard 13.
 * 2. LOGGED OUT. `/` and `/login` are both wrapped in RedirectKnownUser
 *    (App.tsx:117-121, :147-152), which sends an authenticated, onboarded user
 *    straight to /feed, so these two ids are excluded from pass 1 rather than
 *    captured and overwritten.
 * 3+4. FRESH USER, once per onboarding shot. The seeded user cannot film
 *    onboarding at all: scripts/seed-database/seed-users.ts:41 calls
 *    `userService.onboard(user.id)`, and OnboardingPage.tsx:231-233 returns
 *    `<Navigate to="/feed" replace />` for an onboarded user — the wizard is
 *    unreachable, exactly as tests/e2e/onboarding.spec.ts:3-9 says. So this
 *    pass signs up a throwaway account per run (see VIDEO_FRESH_USER below).
 *
 *    It is THREE passes, not one, on purpose. OnboardingPage persists progress
 *    server-side on every Next (persistProgress -> saveProgress) and rehydrates
 *    from it on mount (OnboardingPage.tsx:108-135), so a second onboarding shot
 *    sharing the account would resume mid-wizard AND render the "Welcome back.
 *    Everything you've entered is saved." banner over the shot. One capture
 *    invocation == one fresh account == one clean run through the wizard.
 *
 *    The fresh pass needs signup codes off — config/default.json ships
 *    features.require.signup.codes=true and .env.default:65 leaves the override
 *    commented out, so export ENABLE_REQUIRE_SIGNUP_CODES=false on the API
 *    process before capturing (video/README.md, "The stage").
 *
 * ── Determinism hazards found in this repo ───────────────────────────────────
 * 1. SEED DATE-SHIFT (worst offender).
 *    backend/apps/api/scripts/seed-database/main.ts:159-168 rebases the ENTIRE
 *    seed corpus so its newest record lands "yesterday" relative to the wall
 *    clock at seed time. Re-seed on a different day and every date, date-group
 *    header and timeline bucket in the app moves. Capture cannot fix this; it is
 *    a property of the fixture. Seed and capture in the same job.
 * 2. FROZEN CLOCK vs THAT SHIFT — `fixedTime` is OFF here on purpose.
 *    video-kit freezes the browser clock with Playwright's `clock.install()`.
 *    Because the seed is rebased onto real "now", pinning the browser to a fixed
 *    past instant would render every seeded record in the future ("in 48 days").
 *    `clock.install()` also fakes setTimeout/setInterval/requestAnimationFrame,
 *    which would freeze the onboarding Intro typewriter
 *    (pages/OnboardingPage/Intro.tsx) after one character, stall the search
 *    debounce (ExplorerToolbar.tsx:983) and stop the force-graph simulation
 *    mid-settle. Residual clock volatility is handled by masking `<time>`
 *    instead. Override with VIDEO_FIXED_TIME=<iso> if you ever seed against a
 *    pinned clock.
 * 3. RELATIVE / ABSOLUTE TIMES — every list row renders a `<time>` from
 *    formatRowTime (MemoryPage/Components/utils.tsx:337), which switches between
 *    "3:42 PM", "Jun 14" and "Jun 14, 2025" depending on today. Masked.
 * 4. HBPE FORECAST STRIP — the feed's `role="img"` strip
 *    (components/ForecastStrip/ForecastStrip.tsx:288) plots per-bucket
 *    probabilities from the behavioural model. Masked.
 * 5. ACTIVITY TIMELINE RAIL — NOT masked, and the known residual drift.
 *    MemoryPage/ActivityTimelineRail.tsx bounds its grid on today's local day
 *    key and colours each cell by per-day counts, so it moves whenever the seed
 *    moves. It has no stable hook to mask (no id/testid/aria-label on its root)
 *    and blanking it would punch a black column through the hero shot. Masking
 *    it needs a one-line app change (a `data-testid` on the rail root) that is
 *    out of scope for this PR. Until then, expect the weekly workflow to open a
 *    drift PR after any re-seed.
 * 6. LEAFLET / ARCGIS TILES — components/Map/Map.tsx:35 loads raster tiles from
 *    server.arcgisonline.com. That is live external network: an offline runner
 *    renders an empty pane, and tile revisions change the bytes. The attribution
 *    control is masked; the tiles themselves cannot be.
 * 7. THE GALLERY HAS NO PHOTOS, AND MinIO IS NOT THE REASON — so the gallery
 *    scene is CUT, not captured. Kept here because the next person to reach for
 *    `?view=gallery` needs to know why it is not in the storyboard.
 *    GalleryView.tsx:37-39 builds tiles from `data.map(getEntityMedia)`, and
 *    GalleryView/media.ts:46-95 returns media only for a FileType (needs
 *    galleryContentType + a gallery URL) or an EventType linked to a file. The
 *    seed creates NEITHER: main.ts:83-84 does
 *    `.overrideProvider(FileService).useValue({})` and main.ts:186-188 comments
 *    out `seedContent` ("Our seed content is logically incosistent"). Zero file
 *    records exist, so every tile falls through to the typed-card branch at
 *    GalleryView.tsx:130 and a store visitor sees a Gallery tab with no images.
 *    Standing MinIO up (docker-compose.yml:44-52, the `object-store` service)
 *    would change nothing on its own — there is nothing to serve. Re-adding the
 *    scene needs BOTH the object-store service AND a step that uploads sample
 *    images through the files API after the app is up.
 * 8. FEATURE FLAGS decide which routes even exist, and which headings render.
 *    backend/apps/api/config/default.json ships chat.page=false,
 *    files.page=false, jobs.page=false, stats.page=false — with the stock
 *    .env.default those routes render NotFound, so nothing here films them.
 *    insights.page / new.insights.page / tags.page / hbpe are on.
 *    `actions` now ships TRUE (config/default.json:162, flipped in 1295f2fd1).
 *    FeedPage.tsx:414-416 gates the whole actions block on
 *    `(actionsEnabled || question)` and renders its heading as
 *    `actionsEnabled ? 'Actions' : 'Questions'`, so with stock config the feed
 *    shot gets the actions carousel and ENABLE_ACTIONS=true is now redundant
 *    (harmless, but no longer load-bearing). The frontend reads flags at runtime
 *    from /api/_internal/features (common/feature/useFeatures.ts:34).
 * 9. RESPONSIVE SPLIT — /memory renders DesktopMemoryPage above 768px and
 *    MobileMemoryPage below (packages/common useDeviceLayout, MOBILE_BREAKPOINT
 *    768), and capture films 1280px AND 360px with the SAME selectors. The
 *    desktop breadcrumb view-switcher (`aria-label="List view — change view"`,
 *    DesktopMemoryPage.tsx:293) does not exist on mobile, so no waitFor here
 *    uses it — every selector was chosen to resolve at both widths. The details
 *    sheet passes this test on purpose: DesktopMemoryPage.tsx:375-378 and
 *    MobileMemoryPage.tsx:147-150 render the identical `<Sheet>`, so
 *    `[data-slot="sheet-content"]` resolves at both. So does the graph view —
 *    both pages render `<GraphView>` for ?view=graph, only the variant differs.
 *
 *    /feed FAILED this test and was fixed. FeedPage.tsx:288 returns an entirely
 *    separate mobile tree, and the two section headings — `<h2>Actions</h2>`
 *    (:416) and `<h2>Insights & Summaries</h2>` (:459) — exist ONLY in the
 *    desktop branch below it. feed-overview used to wait on both, so the 360px
 *    capture could never resolve them: 25s deadlock, dropped shot, "capture
 *    pending" slate in the portrait cut only. Its guard is now
 *    `text=Watch a movie together` — a seeded action
 *    (scripts/seed-database/data/actions.ts:23), rendered as a BentoCard title
 *    in BOTH branches, and content-gated the way hazard 10 gates the graph:
 *    an unseeded feed renders "All Caught Up!" (FeedPage.tsx:300, :420-424) and
 *    the shot fails loudly instead of filming an empty product with an
 *    exclamation mark in it. Embla keeps every slide in the DOM with a real
 *    bounding box (Carousel.tsx:96-101), so the selector resolves regardless of
 *    which card the carousel happens to rest on.
 *
 *    ⚠️ IT MUST NOT BE THE *FIRST* SEEDED ACTION. The guard used to be
 *    `text=Make family dinner tonight` (actions.ts:13) on the reasoning that the
 *    first entry in the seed file is certain to render. It is the one entry
 *    certain NOT to. FeedPage.tsx:42 asks for five — `useActionListService(5)` —
 *    and ACTIONS holds six, served newest-first, so the carousel renders
 *    actions.ts entries 5..1 (Weather update, Anniversary gift ideas, Shop for
 *    this week's groceries, Take a break this weekend, Watch a movie together)
 *    and drops entry 0 every single time. That guard could never resolve at
 *    either viewport, and it cost this shot both passes until it was measured
 *    against a live seeded stack. If the seed grows past six actions, re-check
 *    this selector: only the five NEWEST survive the limit.
 * 10. FORCE-GRAPH LAYOUT — a known residual drift, same class as hazard 5.
 *    memory-graph-view films GraphExplorerModal's force simulation. Node
 *    positions come out of the layout's own randomness, so the PNG bytes move
 *    between runs even when nothing about the product changed. `settle` is
 *    2500ms so the simulation is at rest rather than mid-fling, but expect this
 *    shot to show up in the weekly drift PR. Its `waitFor`
 *    (`[aria-label="Hop depth"]`) sits inside the branch reached only AFTER the
 *    `visibleNodes.length === 0` early return at GraphExplorerModal.tsx:1053,
 *    so an unseeded graph fails loudly instead of quietly filming the
 *    "Your knowledge graph is still taking shape" placeholder. Be aware the
 *    blast radius is the whole pass, not this shot: `ci-video capture` exits 1
 *    on any failure, so an empty graph fails the eight other authenticated shots'
 *    step too. That is the intended trade — a lenient selector here would film
 *    the placeholder and ship it as if it were the graph — but it does mean a
 *    graph regression reads as "video job broken", not "one shot missing".
 * 11. DEEP-LINKED SUMMARY — insight-detail-view navigates straight to
 *    /insights/01936cb0-0000-7000-8000-000000000003 rather than clicking the
 *    first card on /insights. That uuid is pinned in
 *    scripts/seed-database/data/summaries.ts:166 and written through verbatim by
 *    seed-summaries.ts (SummaryService.ts:27 honours a supplied summaryId), so
 *    both the route and the h1 ("Daily Summary") survive a re-seed. Clicking
 *    nth=0 would not — list order is not pinned.
 * 12. /connect MUST BE SCROLLED, and the `scroll` verb cannot do it.
 *    The unscrolled 1280x720 viewport lands on ConnectPage.tsx:35-70, where the
 *    Firefox (:60) and Safari (:67) cards are `disabled` and the Safari copy
 *    (:66) puts "seamless" — a word banned by the messaging canon — on screen.
 *    connect-providers therefore scrolls to Service Integrations
 *    (ConnectPage.tsx:163-168), which names Microsoft, Google, Meta, Spotify,
 *    Steam, GitHub and Signal. It uses `eval` + scrollIntoView, NOT the `scroll`
 *    verb: `scroll` is `window.scrollTo` (video-kit capture.mjs:144-146) and the
 *    window does not scroll here — PageContent.tsx is `h-full overflow-auto`, so
 *    the scroller is an inner div and `scroll` would be a silent no-op.
 *    Note the section also carries ten "Coming soon." disabled cards further
 *    down (ServiceIntegrationsSection.tsx:95-183); the shot is framed at the
 *    heading so the enabled providers lead.
 * 13. THE MAP IS STRUCTURALLY EMPTY WITH THIS SEED — the scene is UNCAPTURED,
 *    for the same reason hazard 7 cut the gallery. Do not "fix" it by loosening
 *    the selector; the screen has nothing on it.
 *    MapView.tsx:630 opens on a hardcoded San Francisco centre
 *    ([37.7749, -122.4194]) and fetches only what falls inside the current
 *    viewport's `?bbox=`. That alone would be survivable — the seeded places are
 *    in Laguna Beach, so panning south would find them. The real blocker is one
 *    level down: the map plots the PostGIS column `ci.entities.location_point`,
 *    and **every row in a freshly seeded database has it NULL**. Verified:
 *      SELECT count(*) FROM ci.entities WHERE location_point IS NOT NULL;  -- 0
 *    The 33 `Location` entities DO carry real coordinates, but only inside
 *    `properties` JSONB ('latitude'/'longitude'), which is what the details
 *    sheet reads (hence Pizza Night showing 33.530831, -117.757571 while the map
 *    shows nothing). `PlaceService` accepts TOP-LEVEL `latitude`/`longitude` and
 *    is the only thing that populates `location_point` (PlaceService.ts:754),
 *    but data/places.ts nests them under `properties` and seed-places.ts passes
 *    only `{id, name, properties}` — so the typed column is never written. The
 *    geocode backfill that would otherwise fill it is skipped outright without
 *    GEOCODING_API_KEY / GOOGLE_MAPS_KEY (the seed says so on stdout).
 *    Result: /memory?view=map renders TimelineView's "No memories yet — Your
 *    timeline will fill in as memories are created." over an unpinned San
 *    Francisco. No markers, no clusters, stable across 20s — not a load race.
 *    Its `waitFor` was `.leaflet-container`, which is purely structural and
 *    resolves on an empty map, so unlike the graph (hazard 10) it failed OPEN
 *    and filmed the empty state. Filming that under the caption "Anything with a
 *    place gets one" is the exact lie this file exists to prevent.
 *    TO RE-ENABLE: teach seed-places.ts to lift `properties.latitude/longitude`
 *    into the top-level create call so `location_point` is written, re-seed, then
 *    give the shot a bbox around Laguna Beach and a CONTENT-GATED waitFor (a
 *    marker/cluster selector — never `.leaflet-container`). That is a backend
 *    fixture change with its own test blast radius, so it is deliberately NOT
 *    bundled into the video PR.
 * 14. `Form.Control` RENAMES data-slot, so `[data-slot="checkbox"]` matches
 *    NOTHING inside a form. shadcn's Checkbox does render data-slot="checkbox",
 *    but FocusAreas.tsx:76 wraps it in `<Form.Control>`, which is a Radix `Slot`
 *    that merges its own props onto the child and overwrites the attribute with
 *    `data-slot="form-control"`. onboarding-focus used to tick its two boxes via
 *    `[data-slot="checkbox"] >> nth=0|2`; on a live stack that locator resolves
 *    to zero elements and the click times out after 15s at both viewports.
 *    It now clicks the ids FocusAreas.tsx:52 assigns each option —
 *    `#focus-area-personal_fitness` and `#focus-area-communication` — which are
 *    stable, readable, and say in the storyboard which two areas get ticked
 *    instead of leaving it to positional nth=. If you need a positional
 *    selector here, `button[role="checkbox"]` is the one that survives the Slot.
 * 15. THE SEED PRODUCES NO DUPLICATE PEOPLE, so /people has no merge card.
 *    PeoplePage.tsx:349 renders the "Possible duplicates" Card only when
 *    `personDuplicates` comes back non-empty, and that resolver
 *    (PersonResolver.ts:380 -> PersonDuplicateService.findDuplicateGroups)
 *    groups live people by a SHARED normalized email, phone or display name.
 *    The seeded corpus is 64 people with 64 distinct names and no contact
 *    details to collide on, so the query is legitimately empty and the whole
 *    card is absent — no error, no placeholder, just no section.
 *    people-directory used to gate on `text=Possible duplicates`, which
 *    therefore deadlocked for 20s at both viewports and dropped the shot. It now
 *    gates on `text=Sarah Smith` (data/people/family.ts:20 — the spouse persona,
 *    the most structurally load-bearing name in the fixture), which keeps the
 *    hazard-10 property of failing loudly on an empty directory.
 *    ⚠️ EDITORIAL, NOT FIXED HERE: the scene's narration still says the product
 *    "spots the duplicates". The FEATURE is real and shipped (PersonMergeService,
 *    the rejectPersonDuplicates mutation, DuplicateGroupCard) — it simply has no
 *    data to act on in this fixture, so the claim is no longer demonstrated by
 *    the frame underneath it. Either the seed grows a deliberate collision (two
 *    people sharing one email is enough) or that half-sentence should go.
 */

const BASE_URL = process.env.APP_URL ?? 'http://localhost:5173';

// Matches .env.default / .github/workflows/e2e.yml. Throwaway dev credentials
// for an ephemeral, seeded database — not a secret.
const EMAIL = process.env.AUTH_DEFAULT_USER_EMAIL ?? 'jsmith@example.com';
const PASSWORD = process.env.AUTH_DEFAULT_USER_PASSWORD ?? ']60.a6{CJ}lB*rHAp;w;';

const LOGGED_OUT = process.env.VIDEO_LOGGED_OUT === '1';

// Pass 3/4: sign up a throwaway account instead of logging in as the seeded
// (already-onboarded) jsmith, so the onboarding wizard is reachable at all.
const FRESH_USER = process.env.VIDEO_FRESH_USER === '1';

/**
 * A per-context throwaway identity.
 *
 * `name` MUST differ from `email`. UserType.ts:45 computes
 * `needsIdentityStep: user.name === user.email`, and OnboardingPage.tsx:88-93
 * feeds that into buildOnboardingStepKeys — so the name is what decides whether
 * the wizard is 7 steps or 8. Keeping them different pins the step list to
 * ['intro','time-and-place','focus-areas','people','connect-source',
 *  'trust-dial','run-first-sync'] (preference steps are off by default), which
 * is what the storyboard's chained Next clicks count on. Each `before` step is
 * still guarded by a waitFor on that step's own h1, so a wrong count fails
 * loudly instead of filming the wrong screen.
 */
const freshIdentity = () => ({
  name: 'Sam Rivera',
  email: `video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  password: 'correct horse battery staple',
});

export default {
  baseURL: BASE_URL,

  // The app defaults to `system` (ThemeProvider defaultTheme="system"), so the
  // context's colorScheme is what actually picks dark mode. CI apps film dark.
  colorScheme: 'dark',
  locale: 'en-US',
  timezoneId: 'UTC',

  // See hazard 2. Real timers, real clock — unless you have pinned the seed.
  fixedTime: process.env.VIDEO_FIXED_TIME ?? false,

  async onContext(context, { viewport }) {
    // An unstyled or logo-less capture reads as a UI regression but is usually a
    // dead asset. Say so loudly.
    context.on('requestfailed', (req) => {
      if (/\/static\/|\/branding\/|arcgisonline|fonts\.(googleapis|gstatic)/.test(req.url())) {
        console.warn(`  ! asset failed (${viewport}): ${req.url()}`);
      }
    });

    if (LOGGED_OUT) {
      console.log(`  · ${viewport}: VIDEO_LOGGED_OUT=1 — capturing the signed-out shots`);

      return;
    }

    // Same handshake as tests/e2e/global-setup.ts. The session cookie it sets is
    // httpOnly; the app's refresh-on-load re-mints the JWT from it on the first
    // navigation, so no token has to be injected into localStorage.
    const api = context.request;
    await api.get(`${BASE_URL}/api/authenticate/csrf`);
    const { cookies } = await context.storageState();
    const csrf = cookies.find((c) => c.name === 'csrfToken')?.value;
    if (!csrf) {
      throw new Error(
        'capture login failed: /api/authenticate/csrf set no csrfToken cookie — is the API up on :3030 and is Vite proxying /api to it?',
      );
    }

    if (FRESH_USER) {
      // SignupController mints the same httpOnly session cookie the login flow
      // does, so nothing downstream changes — the context is simply a different,
      // un-onboarded person. `signup_code` is omitted deliberately: it is only
      // required when features.require.signup.codes is on, which video.yml turns
      // off for this job.
      const identity = freshIdentity();
      const signup = await api.post(`${BASE_URL}/api/signup`, {
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        data: identity,
      });
      if (!signup.ok()) {
        throw new Error(
          `capture signup failed (${signup.status()}) for ${identity.email} — ` +
            'is ENABLE_REQUIRE_SIGNUP_CODES=false set on this job? ' +
            (await signup.text()),
        );
      }

      console.log(`  · ${viewport}: VIDEO_FRESH_USER=1 — signed up ${identity.email}`);

      return;
    }

    const res = await api.post(`${BASE_URL}/api/authenticate`, {
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      data: { username: EMAIL, password: PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(
        `capture login failed (${res.status()}) for ${EMAIL} — did the seed run? ${await res.text()}`,
      );
    }
  },
};
