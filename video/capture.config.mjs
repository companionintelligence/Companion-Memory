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
 * THREE-PASS CAPTURE. `ci-video capture` creates ONE browser context per
 * viewport and shares it across every shot, so a single run is either logged in
 * or logged out — it cannot be both. This storyboard needs two identities, in
 * three invocations:
 *
 *   ./kit.sh capture --only <the five ids below>       # seeded jsmith
 *   VIDEO_FRESH_USER=1 ./kit.sh capture --only onboarding-connect
 *   VIDEO_FRESH_USER=1 ./kit.sh capture --only onboarding-trust
 *
 * EVERY pass is explicitly scoped, including the first. `ci-video capture` exits
 * 1 if any single shot fails (bin/ci-video.mjs cmdCapture), so an unscoped
 * capture — which would try all seven shots as jsmith, two of them
 * structurally impossible for that identity — aborts the job before passes 2-3
 * run and leaves assets/shots/ empty. The authoritative list lives in
 * video/stage.sh as `capture_all`, which REFUSES TO SHOOT if it and
 * storyboard.json disagree in either direction; video/README.md's Quick start
 * block repeats it. (Those three lines were `npm run capture` until 2026-08-08,
 * when the kit stopped being installed from the registry here — see
 * video/README.md § "Which kit answers, and why it is not installed". There
 * is no .github/workflows/video.yml any more — #1853 deleted it and moved the
 * build local; anything this file used to delegate to that job is spelled out
 * here.)
 *
 * 1. AUTHENTICATED. The five shots behind ProtectedRoute the film uses:
 *    memory-{list-view,detail-sheet,search-results,graph-view}, insights-list.
 *    NOT `/onboarding` — see below. NOT memory-map-view either: the SEED cannot
 *    populate it and a content-gated waitFor therefore fails the whole pass. It
 *    is captured from the real-corpus stage instead — see hazard 13 and
 *    video/README.md — and no scene references it today.
 *    (It was nine shots and five passes until the narrative re-cut. The
 *    signed-out pass shot `/` and `/login`, both wrapped in RedirectKnownUser
 *    (App.tsx:117-121, :147-152) which sends an authenticated, onboarded user
 *    straight to /feed; it is needed again the moment either scene returns.
 *    feed-overview, memory-stats, insight-detail-view and connect-providers
 *    left the storyboard with it and are now un-shootable — see the ⚠️ block
 *    above AUTHED_SHOTS in video/stage.sh.)
 * 2+3. FRESH USER, once per onboarding shot. The seeded user cannot film
 *    onboarding at all: scripts/seed-database/seed-users.ts:41 calls
 *    `userService.onboard(user.id)`, and OnboardingPage.tsx:231-233 returns
 *    `<Navigate to="/feed" replace />` for an onboarded user — the wizard is
 *    unreachable, exactly as tests/e2e/onboarding.spec.ts:3-9 says. So this
 *    pass signs up a throwaway account per run (see VIDEO_FRESH_USER below).
 *
 *    It is ONE PASS PER ONBOARDING SHOT, not one for both, on purpose.
 *    OnboardingPage persists progress
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
 *    probabilities from the behavioural model, and re-forecasts between runs.
 *    IT USED TO BE MASKED, AND THAT WAS THE WRONG CALL. A mask paints the strip
 *    #0A222E and leaves everything around it: the "Tomorrow's Forecast" heading
 *    above, the "Generated 7:11 AM" label and the full WORK/EXERCISE/SOCIAL/…
 *    legend below. What shipped in feed-overview.png (both viewports) is a live
 *    heading over a dead grey bar with a legend for colours that never appear —
 *    a product that looks broken rather than one whose most distinctive widget
 *    was de-jittered. The audit that reviewed the committed shots read it
 *    exactly that way and filed it as an empty state.
 *    The WHOLE SECTION is now hidden at the shutter instead, via the
 *    `data-testid="tomorrows-forecast"` wrapper FeedPage.tsx puts round the
 *    heading and the strip (`display: contents`, so the app's layout is
 *    unchanged). The frame becomes the feed's Actions, which is what the scene's
 *    caption is about, and nothing half-rendered is claimed as working.
 *    A BETTER SHOT IS AVAILABLE TO WHOEVER WANTS IT: a real, colour-coded 24-hour
 *    behaviour strip is one of the most distinctive things this product does. It
 *    needs a pinned forecast — a fixture behind the /forecast query, or a seeded
 *    HBPE run with a frozen `generatedAt` — so the bytes stop moving. Until then
 *    it stays out of frame rather than in it as a rectangle.
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
 *    renders an empty pane, and tile revisions change the bytes. The tiles
 *    cannot be masked.
 *
 *    THE ATTRIBUTION CONTROL USED TO BE MASKED HERE. That was wrong twice over.
 *    Wrong in principle: the honesty rule is that video/ never masks a defect
 *    that belongs in the product, and the one control that would name Esri on
 *    screen is exactly a disclosure, not a nuisance. And wrong in fact: Map.tsx
 *    passes `attributionControl={false}` and gives <TileLayer> no `attribution`
 *    prop, so Leaflet never builds `.leaflet-control-attribution` at all. The
 *    selector matched nothing and the mask painted nothing — check the bottom-
 *    right corner of the committed shot, it is bare tiles.
 *
 *    So the shot was always honest and the PRODUCT is what suppresses the
 *    disclosure. Restoring attribution is a product fix (and a licensing one —
 *    Esri's World Imagery terms require it) that will change this shot and
 *    force a re-shoot against the real-corpus stage. Until then the storyboard
 *    caption names Esri. See docs/architecture/third-party-egress.md.
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
 *
 *    FRAMING, and why the shot's `before` scrolls. The desktop canvas is a fixed
 *    640px (GraphExplorerModal.tsx:1032) under ~250px of header, breadcrumb and
 *    filter chips, in a 720px capture viewport: 170px of the canvas is below the
 *    fold and the committed shot slices "Cycling" and "BBQ" in half at the frame
 *    edge. The old `before` only scrolled when LESS THAN 60% of the canvas was
 *    visible, which 73% is not, so it never fired. Its replacement,
 *    `min(bottom - innerHeight, top - 64)`, fixed the desktop and was NEVER
 *    CHECKED AT 360px, where it is a SILENT NO-OP — the exact trap hazard 9
 *    describes. At mobile width the canvas FITS inside the viewport, so
 *    `bottom - innerHeight` is NEGATIVE, `min` picks it, `max(0, …)` clamps the
 *    result to 0 and nothing scrolls at all. The 9:16 frame that produced was a
 *    quarter filter chips — CHILD_OF / DISLIKES / FRIENDS_WITH / PARENT_OF /
 *    PREFERS / SIBLING_OF / SPOUSE / WORKS_WITH, raw relationship enums in
 *    SCREAMING_SNAKE_CASE — above a graph adrift in the leftover space.
 *    It is now simply `max(0, top - 64)`: align the canvas top just under the
 *    fixed header. Correct at BOTH widths with no branch — a canvas taller than
 *    the viewport is already maximally visible once its top is at the header,
 *    and one shorter than the viewport brings what follows it (on mobile, the
 *    Summary card with its node and relationship counts) into frame beneath.
 *    The filter chips scroll off; a whole, legible graph is the better shot.
 *    The other half of that fix is in the product: ForceGraph now fits the view
 *    to the settled nodes (components/ForceGraph/fitTransform.ts), so the cluster
 *    fills its canvas instead of sitting as a small blob in the middle of it.
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
 * 13. THE MAP. Now captured — but NOT from this seed, and the previous entry
 *    here named the wrong column. Corrected, with the evidence, because the old
 *    diagnosis sends the next person to fix a file that cannot fix the map.
 *
 *    WHAT THE MAP ACTUALLY PLOTS. Not `ci.entities.location_point`.
 *    MemoryPage.tsx:45-46 forces `hasLocation: true` whenever `view=map`;
 *    SearchResolver.ts:492 turns that into `eventsOnly`, so `PlaceType` can
 *    never reach the client on this route at all. The pins come from
 *    `ci.events.location_coordinates` — EventService.ts:559
 *    (`event.location_coordinates IS NOT NULL`) plus the ST_Within(bbox) clause
 *    at :571. `location_point` is read by exactly one query, PlaceService's
 *    `findNearby`/`placesNear`, which this view does not call.
 *
 *    SO THE SEED NESTING BUG IS REAL BUT ORTHOGONAL. data/places.ts:13-20 does
 *    nest lat/lng under `properties`, and `PlaceService.create()` (line 510)
 *    ignores top-level latitude/longitude entirely — only `update()` (:754) and
 *    `PlaceResolver.createPlace` (:107) convert them, and only into
 *    `locationPoint`. Fixing seed-places.ts is correct on its own merits (it
 *    fixes placesNear and the GIS index) and it will still leave the map empty.
 *    THE SEED-SIDE FIX FOR THE MAP is in seed-events.ts:23-38 / data/events.ts:
 *    seeded events pass `location_entity_id` and never `location_coordinates`,
 *    and `EventService.toEntityFields` (:96-99) only copies that column when the
 *    caller supplies it. Give each seeded event a
 *    `location_coordinates: { type: 'Point', coordinates: [lng, lat] }` from its
 *    linked place and the seed will plot. NOT DONE HERE — unverified fixture
 *    changes are worse than a documented gap.
 *
 *    HOW THE COMMITTED SHOT WAS TAKEN. Against the owner's real archive
 *    (826,478 items) pushed into a throwaway stage — see video/README.md,
 *    "The real-corpus stage". 83 of those events carry genuine WGS84
 *    coordinates, so the map plots real clusters. Note the transport matters:
 *    the importer's DEFAULT `/v1` lane drops geo (captureEventSchema in
 *    domains/ingest/types.ts:44 has no location field; the importer folds
 *    `locationCoordinates`/`locationName` into `payload`, and
 *    BulkIngestController's materialize never lifts them back out). The
 *    GraphQL lane (`CI_PUSH_TRANSPORT=graphql`) writes the typed columns, and
 *    that is the lane the stage recipe uses.
 *
 *    THE waitFor IS NOW CONTENT-GATED, as hazard 10 demands:
 *    `.leaflet-marker-pane .custom-map-marker, .leaflet-marker-pane
 *    .memory-map-cluster` (Marker.tsx:100, MapView.tsx:152). Never
 *    `.leaflet-container` — it is structural and resolves on an empty map,
 *    which is how this shot previously failed OPEN and filmed "No memories
 *    yet" under the caption "Anything with a place gets one".
 *
 *    FRAMING IS A PRIVACY CONSTRAINT, NOT A STYLE CHOICE. At >=768px the map
 *    renders `Map.Panel position="left" className="w-[300px]"` holding
 *    TimelineView, and against the real archive every card in it is a full
 *    street address (Uber trip titles are "<pickup> → <dropoff>"). The owner's
 *    rule for these cuts is aggregate views only, so the panel is masked at
 *    the shutter (it is the only mask here that redacts rather than
 *    de-jitters) AND the scene declares `motion: "hold"` with a
 *    `focus.landscape` rectangle that starts at x=0.284 — just right of the
 *    panel — so no rendered frame contains it either.
 *    ⚠️ THAT SECOND HALF IS KIT-DEPENDENT. `focus` landed in video-kit 0.4.0
 *    (src/camera.mjs); an older kit ignores the key with no warning and renders
 *    the whole frame, masked panel and all. The redaction is unaffected — the
 *    rectangle is opaque and nothing legible is under it — but the framing claim
 *    holds only when the kit being rendered from is 0.4.0 or newer. Check the
 *    CI-Common checkout's branch and the kit's package.json version first; a
 *    working tree parked on an old branch is the documented failure mode, and
 *    every video/package.json in the fleet still declares `^0.1.0`.
 *    The markers themselves
 *    carry no labels (Marker.tsx:74-114 renders no text and no <Popup>) and
 *    cluster bubbles render only an integer, so the map canvas is safe at any
 *    zoom the shot uses. Do not click a cluster in `before`: MapView.tsx:203
 *    opens a popup with event titles, and MapView.tsx:290 zooms to maxZoom 17.
 *    FitBoundsOnce (MapView.tsx:495) caps at zoom 13 and lands at continental
 *    scale for this corpus; two consecutive captures were byte-identical.
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
const PASSWORD = process.env.AUTH_DEFAULT_USER_PASSWORD ?? 'replace-me-pw-000000';

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
