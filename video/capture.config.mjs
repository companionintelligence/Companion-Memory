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
 * FOUR-PASS CAPTURE. `ci-video capture` creates ONE browser context per viewport
 * and shares it across every shot, so a single run is either logged in or logged
 * out — it cannot be both. This storyboard needs three different identities, in
 * four invocations:
 *
 *   npm run capture -- --only <the eleven ids below>   # seeded jsmith
 *   VIDEO_LOGGED_OUT=1     npm run capture -- --only splash-screen,login-form
 *   VIDEO_FRESH_USER=1     npm run capture -- --only onboarding-focus
 *   VIDEO_FRESH_USER=1     npm run capture -- --only onboarding-connect
 *
 * EVERY pass is explicitly scoped, including the first. `ci-video capture` exits
 * 1 if any single shot fails (bin/ci-video.mjs cmdCapture), so a bare
 * `npm run capture` — which would try all fifteen shots as jsmith, four of them
 * structurally impossible for that identity — aborts the job before passes 2-4
 * run and leaves assets/shots/ empty. The authoritative list lives in
 * .github/workflows/video.yml; keep the two in step.
 *
 * 1. AUTHENTICATED. The eleven shots behind ProtectedRoute: feed-overview,
 *    memory-{list-view,detail-sheet,gallery-view,search-results,map-view,
 *    graph-view}, people-directory, insights-list, insight-detail-view,
 *    connect-providers. NOT `/`, `/login` or `/onboarding` — see below.
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
 *    It is TWO passes, not one, on purpose. OnboardingPage persists progress
 *    server-side on every Next (persistProgress -> saveProgress) and rehydrates
 *    from it on mount (OnboardingPage.tsx:108-135), so a second onboarding shot
 *    sharing the account would resume mid-wizard AND render the "Welcome back.
 *    Everything you've entered is saved." banner over the shot. One capture
 *    invocation == one fresh account == one clean run through the wizard.
 *
 *    The fresh pass needs signup codes off — config/default.json ships
 *    features.require.signup.codes=true and .env.default:65 leaves the override
 *    commented out, so .github/workflows/video.yml sets
 *    ENABLE_REQUIRE_SIGNUP_CODES=false on the job.
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
 * 7. THE GALLERY HAS NO PHOTOS, AND MinIO IS NOT THE REASON.
 *    GalleryView.tsx:37-39 builds tiles from `data.map(getEntityMedia)`, and
 *    GalleryView/media.ts:46-95 returns media only for a FileType (needs
 *    galleryContentType + a gallery URL) or an EventType linked to a file. The
 *    seed creates NEITHER: main.ts:83-84 does
 *    `.overrideProvider(FileService).useValue({})` and main.ts:186-188 comments
 *    out `seedContent` ("Our seed content is logically incosistent"). Zero file
 *    records exist, so every tile falls through to the typed-card branch at
 *    GalleryView.tsx:130. Standing MinIO up (docker-compose.yml:44-52, the
 *    `object-store` service) would change nothing on its own — there is nothing
 *    to serve. The storyboard's gallery caption and narration were rewritten to
 *    describe the grid that actually renders rather than promise thumbnails.
 *    Filming real thumbnails needs BOTH the object-store service AND a step
 *    that uploads sample images through the files API after the app is up.
 * 8. FEATURE FLAGS decide which routes even exist, and which headings render.
 *    backend/apps/api/config/default.json ships chat.page=false,
 *    files.page=false, jobs.page=false, stats.page=false — with the stock
 *    .env.default those routes render NotFound, so nothing here films them.
 *    insights.page / new.insights.page / tags.page / hbpe are on.
 *    `actions` ships FALSE, and FeedPage.tsx:414-416 both gates the block on
 *    `(actionsEnabled || question)` and renders its h2 as
 *    `actionsEnabled ? 'Actions' : 'Questions'` — so the feed shot's
 *    `h2:text-is("Actions")` only resolves because video.yml sets
 *    ENABLE_ACTIONS=true (mapped in config/custom-environment-variables.json).
 *    The frontend reads flags at runtime from /api/_internal/features
 *    (common/feature/useFeatures.ts:34), so a job-level env var is enough.
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
 *    on any failure, so an empty graph fails the ten other authenticated shots'
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
