import { type ReactNode, Suspense, lazy, useEffect } from 'react';

import {
  ConnectionModeProvider,
  DeviceLayoutProvider,
  LoadingPage,
  OutboxQueueProvider,
  isNativePlatform,
  isTauriPlatform,
  needsNativeCloudConnect,
  useDeviceLayout,
} from '@ci/common';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  type Location,
} from 'react-router-dom';

import { ApolloProvider } from '@/api/ApolloProvider';
import { FeaturesProvider, useFeatures } from '@/common/feature';
import { MemoryHubLayout, MemoryHubRoute } from '@/components/MemoryHub';
import NotFoundPage from '@/components/NotFound';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { RedirectKnownUser } from '@/components/RedirectKnownUser';
import { RequireOnboarded } from '@/components/RequireOnboarded';
import { ThemeProvider, BackgroundProvider } from '@/components/ThemePicker';
import { UnsentCapturesSignOutDialog } from '@/components/UnsentCapturesSignOutDialog';
import {
  AuthProvider,
  CaptureModalProvider,
  ModelProvider,
  useAuth,
  useLocationTracking,
  useNativeShell,
  usePreventOverscroll,
  useStatusBarScrollToTop,
} from '@/hooks';
import { DateTimeFormatProvider } from '@/hooks/useDateTimeFormat';
import { Centered as CenteredLayout, Main as MainLayout } from '@/layouts';
import { CHAT_BASE, chatThreadPath } from '@/pages/ChatPage/chatPaths';
import DesktopSignInPage from '@/pages/DesktopSignInPage';
import LoginPage from '@/pages/LoginPage';
import SignupPage from '@/pages/SignupPage';
import SplashPage from '@/pages/SplashPage';

const LazyPowerSyncProvider = lazy(() =>
  import('@/api/powersync/PowerSyncProvider').then((m) => ({ default: m.PowerSyncProvider })),
);

const ChatPage = lazy(() => import('@/pages/ChatPage'));
const CommunicationPage = lazy(() => import('@/pages/CommunicationPage'));
const ConceptPage = lazy(() => import('@/pages/ConceptPage'));
const ConnectionPage = lazy(() => import('@/pages/ConnectionPage'));
const ContentPage = lazy(() => import('@/pages/ContentPage'));
const EventPage = lazy(() => import('@/pages/EventPage'));
const FeedPage = lazy(() => import('@/pages/FeedPage'));
const AsksPage = lazy(() => import('@/pages/AsksPage'));
const ForecastPage = lazy(() => import('@/pages/ForecastPage'));
const ItemPage = lazy(() => import('@/pages/ItemPage'));
const SourcesPage = lazy(() => import('@/pages/SourcesPage'));
const JobsPage = lazy(() => import('@/pages/JobsPage'));
const ApprovalsPage = lazy(() => import('@/pages/ApprovalsPage'));
const ActivityPage = lazy(() => import('@/pages/ActivityPage'));
const ThingsPage = lazy(() => import('@/pages/ThingsPage'));
const ReceiptsPage = lazy(() => import('@/pages/ReceiptsPage'));
const ReceiptPage = lazy(() => import('@/pages/ReceiptPage'));
const MemoryPage = lazy(() => import('@/pages/MemoryPage'));
const NotePage = lazy(() => import('@/pages/NotePage'));
const NotesPage = lazy(() => import('@/pages/NotesPage'));
const PlanPage = lazy(() => import('@/pages/PlanPage'));
const OAuthCallbackPage = lazy(() => import('@/pages/OAuthCallbackPage'));
const OnboardingPage = lazy(() => import('@/pages/OnboardingPage'));
const OpenIDCallbackPage = lazy(() => import('@/pages/OpenIDCallbackPage'));
const PeoplePage = lazy(() => import('@/pages/PeoplePage'));
const PersonPage = lazy(() => import('@/pages/PersonPage'));
const PlacePage = lazy(() => import('@/pages/PlacePage'));
const PlacesPage = lazy(() => import('@/pages/PlacesPage'));
const ProviderPage = lazy(() => import('@/pages/ProviderPage'));
const ContentLibraryPage = lazy(() => import('@/pages/ContentLibraryPage'));
const SavedSearchesPage = lazy(() => import('@/pages/SavedSearchesPage'));
const ServerSettingsPage = lazy(() => import('@/pages/ServerSettingsPage'));
const DeviceConnectPage = lazy(() => import('@/pages/DeviceConnectPage'));
const SharedSearchPage = lazy(() => import('@/pages/SharedSearchPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const SelfPage = lazy(() => import('@/pages/SelfPage'));
const TagsPage = lazy(() => import('@/pages/TagsPage'));
// Pulls SchedulePage in with it — SchedulePage is not routed on its own.
const TodayPage = lazy(() => import('@/pages/TodayPage'));
const SummaryDetailPage = lazy(() => import('@/pages/SummaryDetailPage'));

function RedirectInsightsSummary() {
  const { id } = useParams<{ id: string }>();

  return <Navigate to={`/brief/summaries/${id ?? ''}`} replace />;
}

/**
 * The brief now lives inside Calendar, so both of its old addresses — plus
 * Calendar's own former top-level address — land there.
 *
 * Aimed at /plan/calendar rather than chained through /calendar or /brief,
 * which would cost a second redirect on every old link. The action id is
 * carried across because the brief's cards deep-link by it — dropping it
 * would open the page but not the card someone was sent.
 */
function RedirectToCalendar() {
  const { id } = useParams<{ id?: string }>();

  return <Navigate to={id ? `/plan/calendar/${id}` : '/plan/calendar'} replace />;
}

/**
 * `/plan` bare picks the sub-view that's actually available: Tasks when
 * `planning.page` is on, Calendar otherwise — the same fallback
 * `appHomePath` used to compute at every caller, now resolved once here.
 */
function RedirectToPlanningDefault() {
  const { isFeatureEnabled } = useFeatures();

  return <Navigate to={isFeatureEnabled('planning.page') ? '/plan/tasks' : '/plan/calendar'} replace />;
}

function RedirectFeedSummaryToBrief() {
  const { id } = useParams<{ id: string }>();

  return <Navigate to={`/brief/summaries/${id ?? ''}`} replace />;
}

function RedirectToChat() {
  const { id } = useParams<{ id?: string }>();

  return <Navigate to={id ? chatThreadPath(id) : CHAT_BASE} replace />;
}

function RedirectProfileToSelfSettings() {
  const rest = useParams()['*'];

  return <Navigate to={rest ? `/self/settings/${rest}` : '/self/settings'} replace />;
}

/**
 * PowerSync only matters once someone is signed in.
 *
 * It was mounted unconditionally, which put ~200 KB of sync engine in the chunk
 * every visitor downloads before first paint and opened a WASQLite IndexedDB
 * database for people sitting on the splash screen who may never sign in. Signed
 * out, the tree renders without it; signed in, it loads and mounts exactly as
 * before — every consumer of PowerSyncContext lives behind ProtectedRoute.
 */
function PowerSyncBoundary({ children }: { children: ReactNode }) {
  const [{ authenticated, authToken }] = useAuth();

  if (!authenticated && !authToken) {
    return children;
  }

  return (
    <Suspense fallback={<LoadingPage />}>
      <LazyPowerSyncProvider>{children}</LazyPowerSyncProvider>
    </Suspense>
  );
}

function Providers({ children }: { children: ReactNode }) {
  // React Router 7 wraps every navigation in React.startTransition unless
  // told not to. That fights Apollo's useQuery, which re-observes (and
  // fires the network request) during render: React renders the transition
  // tree with the new URL, Apollo emits a store change mid-render, React
  // throws that render away and re-renders synchronously with the OLD
  // URL, Apollo re-observes the old variables and aborts the new request —
  // and the two keep trading places on every response. Measured on
  // /memory/events when the What bar wrote ?eventTypes=: one click, a
  // dozen Search requests, half aborted, each with the pre-click variables.
  // Synchronous navigation restores one request per URL change. The cost
  // is that a lazily-loaded route shows its Suspense fallback on first
  // visit instead of holding the previous screen — the v6 behaviour.
  return (
    <Router useTransitions={false}>
      <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
        <BackgroundProvider>
          <DeviceLayoutProvider args={[]}>
            <ConnectionModeProvider args={[]}>
              {/* Inside ConnectionModeProvider: the outbox flush loop is driven by the
                  resolved connection mode rather than a timer of its own. */}
              <OutboxQueueProvider args={[]}>
                <AuthProvider args={[]}>
                  {/* The phone's sign-out asks here when captures have not uploaded, whichever
                      Log out started it. */}
                  <UnsentCapturesSignOutDialog />
                  <FeaturesProvider args={[]}>
                    <ModelProvider args={[]}>
                      <CaptureModalProvider args={[]}>
                        <ApolloProvider>
                          {/* Inside Apollo: it reads the signed-in person's time format and
                              timezone, and hands every page the formatters that apply them. */}
                          <DateTimeFormatProvider>
                            <PowerSyncBoundary>{children}</PowerSyncBoundary>
                          </DateTimeFormatProvider>
                        </ApolloProvider>
                      </CaptureModalProvider>
                    </ModelProvider>
                  </FeaturesProvider>
                </AuthProvider>
              </OutboxQueueProvider>
            </ConnectionModeProvider>
          </DeviceLayoutProvider>
        </BackgroundProvider>
      </ThemeProvider>
    </Router>
  );
}

function AppRoutes() {
  const { isFeatureEnabled, loading: featuresLoading } = useFeatures();
  const location = useLocation();
  const navigate = useNavigate();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

  // Native shell wiring (splash dismiss, Android back button). Inert on web.
  useNativeShell();

  // Phone: tap the top safe area (status bar / notch) to jump the frontmost
  // list back to the top — iOS convention, implemented in JS because pages
  // scroll inner overflow containers rather than the webview itself.
  const { isMobile } = useDeviceLayout();
  useStatusBarScrollToTop(isMobile === true);

  // Browser location tracking (issue #1811): records ci.position fixes while
  // the user has enabled it in Settings -> Location. Inert when disabled.
  useLocationTracking();

  // Native pairing: `/device-connect` is Portal cloud-connect; `/device-connect/advanced`
  // (and the leftover `/server` alias) are Hub URL / offline-unlock settings. iOS always
  // uses cloud-connect (a leftover docker/LAN origin does not skip it). `/connect` is
  // Sources and must not be used here.
  useEffect(() => {
    const pairing =
      location.pathname === '/device-connect' ||
      location.pathname === '/device-connect/advanced' ||
      location.pathname === '/server';

    if (needsNativeCloudConnect() && !pairing) {
      navigate('/device-connect', { replace: true });
    }
  }, [location.pathname, navigate]);

  return (
    <>
      <Routes location={backgroundLocation ?? location}>
        <Route
          path="/"
          element={
            <RedirectKnownUser>
              {/* The marketing splash is for a browser visitor who has not decided
                  yet. Someone inside the desktop app or the phone app has already
                  installed the thing — they get a way in, not a pitch. Native goes
                  to cloud-connect (it must find an appliance first); desktop is
                  already looking at its own, so it goes straight to sign-in. */}
              {isNativePlatform() ? (
                <Navigate to="/device-connect" replace />
              ) : isTauriPlatform() ? (
                <DesktopSignInPage />
              ) : (
                <SplashPage />
              )}
            </RedirectKnownUser>
          }
        />

        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <OnboardingPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/providers/:id"
          element={
            <ProtectedRoute>
              <ProviderPage />
            </ProtectedRoute>
          }
        />

        {/* Full-bleed splash on sign-in; the picker centers itself. Do not wrap
            this in CenteredLayout — that card column is what hid the Lottie. */}
        <Route path="/device-connect" element={<DeviceConnectPage />} />

        <Route element={<CenteredLayout />}>
          <Route path="/device-connect/advanced" element={<ServerSettingsPage />} />
          <Route path="/server" element={<Navigate to="/device-connect/advanced" replace />} />

          <Route
            path="/login"
            element={
              // Native shells cloud-connect only while they still NEED to: an
              // unpaired shell (no server origin yet, or iOS pointed at a local
              // appliance) must go through DeviceConnectPage, because restoring
              // `/login` from an earlier hop (or an Android deep-link cold start)
              // drops Portal PKCE that only DeviceConnectPage resumes.
              //
              // Once a self-hosted Memory Server origin IS configured, that no
              // longer applies and this redirect was locking the owner out: the
              // only credential form left is Portal's, so an appliance whose
              // owner has no Portal account had no way in at all.
              needsNativeCloudConnect() ? (
                <Navigate to="/device-connect" replace />
              ) : (
                <RedirectKnownUser>
                  <LoginPage />
                </RedirectKnownUser>
              )
            }
          />

          <Route
            path="/signup"
            element={
              <RedirectKnownUser>
                <SignupPage />
              </RedirectKnownUser>
            }
          />
        </Route>

        <Route
          element={
            <ProtectedRoute>
              <RequireOnboarded>
                <MainLayout />
              </RequireOnboarded>
            </ProtectedRoute>
          }
        >
          {/* Intelligence */}
          <Route
            path="/brief/summaries/:id"
            element={
              <ProtectedRoute>
                <SummaryDetailPage />
              </ProtectedRoute>
            }
          />

          {/* Planning: one destination, two sub-views. Tasks rides
              `planning.page` the same way the standalone /plan route used to;
              Calendar is unconditional, so it survives that flag being off —
              see RedirectToPlanningDefault. */}
          <Route path="/plan" element={<RedirectToPlanningDefault />} />

          {isFeatureEnabled('planning.page') && (
            <Route
              path="/plan/tasks"
              element={
                <ProtectedRoute>
                  <PlanPage />
                </ProtectedRoute>
              }
            />
          )}

          <Route
            path="/plan/calendar/:id?"
            element={
              <ProtectedRoute>
                <TodayPage />
              </ProtectedRoute>
            }
          />

          {/* Calendar's own former top-level address. Kept registered
              unconditionally, like the redirects below, so old bookmarks and
              links keep working. */}
          <Route path="/calendar/:id?" element={<RedirectToCalendar />} />

          {isFeatureEnabled('forecast.page') && (
            <Route
              path="/forecast"
              element={
                <ProtectedRoute>
                  <ForecastPage />
                </ProtectedRoute>
              }
            />
          )}

          {/* Both former destinations now resolve to the page that absorbed
              them. /brief/summaries/:id is declared above and is more specific,
              so it still reaches the summary detail page. */}
          <Route path="/brief/:id?" element={<RedirectToCalendar />} />
          <Route path="/schedule" element={<RedirectToCalendar />} />

          {/* Today — the brief's own home, and the only surface that can open
              the actions, insights and summaries the engines compute all day.
              Gated on `today.page`, which ships false.

              Both branches sit at the same path rather than the usual
              "registered only when on": /today has redirected into Calendar
              since the brief cards were folded in there, so leaving the route
              out with the flag off would 404 an address that used to work.
              With the flag off the redirect is exactly what it was.

              The off branch waits out `featuresLoading` for the same reason
              "*" below does: `isFeatureEnabled` reports every flag as off until
              the fetch settles, so deciding early would bounce a hard load of
              /today into Calendar and leave no way back to the page that does
              exist. */}
          {isFeatureEnabled('today.page') ? (
            <Route
              path="/today/:id?"
              element={
                <ProtectedRoute>
                  <FeedPage />
                </ProtectedRoute>
              }
            />
          ) : (
            <Route path="/today/:id?" element={featuresLoading ? <LoadingPage /> : <RedirectToCalendar />} />
          )}

          <Route path="/feed/summaries/:id" element={<RedirectFeedSummaryToBrief />} />
          <Route path="/feed/:id?" element={<RedirectToCalendar />} />

          {/* Nothing in the shell ever linked here — GlobalSearchBox is
              embedded directly in both the desktop header and MobileTopBar
              and commits straight to /memory?search=, and desktop
              search itself is List View in Memory now (the old
              DesktopSearchRedirect this replaced already said so). Kept as a
              redirect, not deleted outright, in case an old bookmark or
              external link still points at /search. */}
          <Route path="/search" element={<Navigate to="/memory" replace />} />

          {/* The Memory hub: every section the strip links to (MEMORY_HUB_SECTIONS)
              is a child of this one layout route, so the strip is mounted once
              and moving between sections only swaps the page under it. A
              section added to the strip belongs in here too; one left outside
              tears the strip down on the way in and out of it. The old
              addresses and the detail pages stay outside: they show no strip.
              The gated sections keep their flag in here, beside a redirect
              outside that carries the same flag. */}
          <Route element={<MemoryHubLayout />}>
            {/* `/memory` is the unfiltered explorer (all kinds). `/memory/events`
                is the same page with the Events submenu's type filter. */}
            <Route
              path="/memory"
              element={
                <MemoryHubRoute>
                  <MemoryPage />
                </MemoryHubRoute>
              }
            />
            <Route
              path="/memory/events"
              element={
                <MemoryHubRoute>
                  <MemoryPage />
                </MemoryHubRoute>
              }
            />
            <Route
              path="/memory/people"
              element={
                <MemoryHubRoute>
                  <PeoplePage />
                </MemoryHubRoute>
              }
            />
            {/* The optional :placeId gives a place row a shareable URL and makes
                Back close its drawer — same shape as /memory/content/:contentId. */}
            <Route
              path="/memory/places/:placeId?"
              element={
                <MemoryHubRoute>
                  <PlacesPage />
                </MemoryHubRoute>
              }
            />
            {/* Ungated, like /memory/people and /memory/places. The old
                `enable.inventory.page` flag shipped `true` in the API's own
                default.json and nothing in the repo turned it off, so it never
                gated anything in practice — but it DID make the route 404 for the
                moment before the global flag fetch settles, and it could not cover
                the sibling Receipts surface (which has no flag of its own). Half a
                gate over one coherent surface is worse than none; the flag is gone.

                `/inventory` stays as a redirect, not a route: it is the URL the
                retired feature shipped under and may sit in a bookmark. */}
            <Route
              path="/memory/things"
              element={
                <MemoryHubRoute>
                  <ThingsPage />
                </MemoryHubRoute>
              }
            />
            <Route
              path="/memory/receipts"
              element={
                <MemoryHubRoute>
                  <ReceiptsPage />
                </MemoryHubRoute>
              }
            />
            {isFeatureEnabled('files.page') && (
              <>
                {/*
                  The optional :contentId gives an individual content row a shareable
                  URL and makes Back close the drawer. It is one route rather than two
                  so ContentLibraryPage stays mounted when the param changes — a second
                  route would remount it and throw away every page the user scrolled in.
                */}
                <Route
                  path="/memory/content/:contentId?"
                  element={
                    <MemoryHubRoute>
                      <ContentLibraryPage />
                    </MemoryHubRoute>
                  }
                />
              </>
            )}
            {isFeatureEnabled('tags.page') && (
              <Route
                path="/memory/tags"
                element={
                  <MemoryHubRoute>
                    <TagsPage />
                  </MemoryHubRoute>
                }
              />
            )}
            <Route
              path="/memory/notes"
              element={
                <MemoryHubRoute>
                  <NotesPage />
                </MemoryHubRoute>
              }
            />
            {isFeatureEnabled('chat.page') && (
              <Route
                path="/memory/chat/:id?"
                element={
                  <MemoryHubRoute>
                    <ChatPage />
                  </MemoryHubRoute>
                }
              />
            )}
          </Route>

          <Route path="/inventory" element={<Navigate to="/memory/things" replace />} />
          <Route path="/receipts" element={<Navigate to="/memory/receipts" replace />} />
          <Route
            path="/receipts/:id"
            element={
              <ProtectedRoute>
                <ReceiptPage />
              </ProtectedRoute>
            }
          />

          {isFeatureEnabled('files.page') && (
            <Route path="/files" element={<Navigate to="/memory/content" replace />} />
          )}

          <Route path="/insights" element={<Navigate to="/plan/calendar" replace />} />
          <Route
            path="/insights/:id"
            element={
              <ProtectedRoute>
                <RedirectInsightsSummary />
              </ProtectedRoute>
            }
          />

          {isFeatureEnabled('tags.page') && (
            <Route path="/tags" element={<Navigate to="/memory/tags" replace />} />
          )}

          {isFeatureEnabled('self.page') && (
            <>
              {/* Legacy addresses, INSIDE the gate that registers their target.
                  These three sat outside it, violating the rule the comment
                  below states: with the flag off they bounced an old bookmark
                  to /self/stats or /self/settings and 404'd it there, at a URL
                  the user never typed. Absent from the table they fall through
                  to "*", which waits for the flags and only then decides. */}
              <Route path="/stats" element={<Navigate to="/self/stats" replace />} />
              <Route path="/profile/*" element={<RedirectProfileToSelfSettings />} />
              <Route path="/system" element={<Navigate to="/self" replace />} />

              {/* About You and Account moved into Self. Specific paths outrank
                  the `/settings/*` wildcard regardless of declaration order, so
                  old bookmarks land on the right Self tab instead of falling
                  through to the settings dialog's appearance fallback. */}
              <Route path="/settings/about-you" element={<Navigate to="/self" replace />} />
              <Route path="/settings/account" element={<Navigate to="/self" replace />} />

              <Route
                path="/self/*"
                element={
                  <ProtectedRoute>
                    <SelfPage />
                  </ProtectedRoute>
                }
              />

              {/* "Questions" is what this page used to be called; it was
                  "Reflections" under Memory, and now lives under Self. All
                  three old paths stay as redirects so bookmarks, docs and any
                  link still in the wild keep working.

                  Declared inside the gate alongside their destination, the way
                  /tags and /files are. A gated route in this app is never
                  registered rather than blocked, so a redirect that outlived
                  its target would send an old bookmark to a URL the table does
                  not contain and 404 it there instead — under a path the user
                  never typed. Absent from the table, these fall through to "*",
                  which holds the loading page until the flags settle and only
                  then decides: redirect if Self exists, 404 at the address
                  actually asked for if it does not.

                  The Reflections tab behind them is separately gated on
                  `insights.page` inside SelfPage, which sends its own misses
                  back to /self rather than 404ing. */}
              <Route path="/prompts" element={<Navigate to="/self/reflections" replace />} />
              <Route path="/memory/questions" element={<Navigate to="/self/reflections" replace />} />
              <Route path="/memory/reflections" element={<Navigate to="/self/reflections" replace />} />
            </>
          )}

          <Route path="/memory/knowledge" element={<Navigate to="/memory?view=graph" replace />} />

          {/* Chat moved under Memory — it's a bounded view over your own
              history the same way Events/People/Places are, not a peer
              destination. The old /chat/:id? address is kept as a redirect
              under the same flag as the route it now points at (in the Memory
              hub layout above), so a bookmark or an external deep-link still
              lands. */}
          {isFeatureEnabled('chat.page') && <Route path="/chat/:id?" element={<RedirectToChat />} />}

          {/* Approvals — the owner's answer queue for anything the capability
              gate stopped. NOT feature-flagged: `tools.pendingActions` gates
              whether the DIAL queues an owner's own actions, but an installed
              app is queued unconditionally (see resolveToolGate's `managed-app`
              rule), so cards can arrive with the flag off. A flag-gated route
              would hide them, which is the one failure mode worse than not
              having the page. */}
          <Route
            path="/approvals"
            element={
              <ProtectedRoute>
                <ApprovalsPage />
              </ProtectedRoute>
            }
          />

          {/* Activity — the tool-call ledger, including the refusals. Sibling of
              /approvals rather than part of it: the queue is the open questions,
              this is the record of every answer and every call that needed none.
              Also unflagged, and for the same reason — a refusal recorded where
              nobody can read it is what made the ledger write-only for a
              fortnight. */}
          <Route
            path="/activity"
            element={
              <ProtectedRoute>
                <ActivityPage />
              </ProtectedRoute>
            }
          />

          {/* Admin / System */}
          {/* One page, five addresses. The section (and, for a category
              deep-link, the category) is read from the pathname inside
              JobsPage — see pages/JobsPage/jobsSections.ts, which is the single
              list the Power Rail submenu renders from too. */}
          {isFeatureEnabled('jobs.page') && (
            <Route
              path="/jobs/*"
              element={
                <ProtectedRoute>
                  <JobsPage />
                </ProtectedRoute>
              }
            />
          )}

          {/* Asks — interpersonal questions between Companions. Gated on `ask`,
              the same flag the backend resolvers check: with it off every ask
              mutation returns `success: false`, so a registered route would be
              a page of dead buttons. Flag-gated routes in this app are never
              registered rather than blocked, which is what we want here. */}
          {isFeatureEnabled('ask') && (
            <Route
              path="/asks"
              element={
                <ProtectedRoute>
                  <AsksPage />
                </ProtectedRoute>
              }
            />
          )}

          {/* Getting data in — one page, two halves. `/sources` and any
              unrecognised half normalise to /sources/connect inside the page,
              which is also where /sources/import lands when `import.page` is
              off. Deliberately NOT flag-gated as a route: a flag-gated route in
              this app is never registered rather than blocked, and the connect
              half has to exist whatever the import flag says. */}
          <Route
            path="/sources/:half?"
            element={
              <ProtectedRoute>
                <SourcesPage />
              </ProtectedRoute>
            }
          />

          {/* The three routes Sources replaced. Kept as redirects so bookmarks,
              docs and any link still in the wild keep working. */}
          <Route path="/connect" element={<Navigate to="/sources/connect" replace />} />
          <Route path="/connections" element={<Navigate to="/sources/connect" replace />} />
          <Route path="/import" element={<Navigate to="/sources/import" replace />} />

          <Route
            path="/connections/:id"
            element={
              <ProtectedRoute>
                <ConnectionPage />
              </ProtectedRoute>
            }
          />

          {/* The Self-bound redirects for these paths are declared inside the
              `self.page` gate above, alongside the route they point at. */}
          <Route
            path="/settings/*"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/oauth/callback"
            element={
              <ProtectedRoute>
                <OAuthCallbackPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/openid/callback"
            element={
              <ProtectedRoute>
                <OpenIDCallbackPage />
              </ProtectedRoute>
            }
          />

          {/* Notes used to be write-only from the shell — reachable to create
              (Add ▸ Note) or open from search, but never browsed. Folded into
              the Memory hub the same way Things/Receipts/Content were: the
              list moves under /memory/* (in the Memory hub layout above), the
              old address stays as a redirect for whatever already links here.
              The detail/edit page keeps its own top-level path, same as
              /people/:id and /receipts/:id. */}
          <Route path="/notes" element={<Navigate to="/memory/notes" replace />} />
          <Route
            path="/notes/:id?"
            element={
              <ProtectedRoute>
                <NotePage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/saved-searches"
            element={
              <ProtectedRoute>
                <SavedSearchesPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/shared/:token"
            element={
              <ProtectedRoute>
                <SharedSearchPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/concepts/:id"
            element={
              <ProtectedRoute>
                <ConceptPage />
              </ProtectedRoute>
            }
          />

          <Route path="/people" element={<Navigate to="/memory/people" replace />} />
          <Route
            path="/people/:id"
            element={
              <ProtectedRoute>
                <PersonPage />
              </ProtectedRoute>
            }
          />

          <Route path="/places" element={<Navigate to="/memory/places" replace />} />
          <Route
            path="/places/:id"
            element={
              <ProtectedRoute>
                <PlacePage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/content/:id"
            element={
              <ProtectedRoute>
                <ContentPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/communications/:id"
            element={
              <ProtectedRoute>
                <CommunicationPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/items/:id"
            element={
              <ProtectedRoute>
                <ItemPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/events/:id"
            element={
              <ProtectedRoute>
                <EventPage />
              </ProtectedRoute>
            }
          />
        </Route>

        {/*
          Fallback. The feature-gated routes above are absent from the table
          until `/api/_internal/features` answers, so on a hard load of one of
          them (/self, /tags, /prompts, or a settings overlay whose restored
          backgroundLocation is one of them) this is what "*" matches. Rendering
          404 there flashed a not-found page over a route that was about to
          exist; wait for the flags instead, exactly as ProtectedRoute waits for
          the session. A genuinely unknown URL still lands on 404, one tick later.
        */}
        <Route path="*" element={featuresLoading ? <LoadingPage /> : <NotFoundPage />} />
      </Routes>

      {backgroundLocation && (
        <Routes>
          <Route
            path="/settings/*"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
        </Routes>
      )}
    </>
  );
}

export default function App() {
  usePreventOverscroll();

  return (
    <Providers>
      <AppRoutes />
    </Providers>
  );
}
