import { type ReactNode, lazy, useEffect } from 'react';

import {
  ConnectionModeProvider,
  DeviceLayoutProvider,
  LoadingPage,
  OutboxQueueProvider,
  isNativePlatform,
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
import { PowerSyncProvider } from '@/api/powersync/PowerSyncProvider';
import { FeaturesProvider, useFeatures } from '@/common/feature';
import NotFoundPage from '@/components/NotFound';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { RedirectKnownUser } from '@/components/RedirectKnownUser';
import { RequireOnboarded } from '@/components/RequireOnboarded';
import { ThemeProvider, BackgroundProvider } from '@/components/ThemePicker';
import {
  AuthProvider,
  CaptureModalProvider,
  ModelProvider,
  useLocationTracking,
  useNativeShell,
  usePreventOverscroll,
  useStatusBarScrollToTop,
} from '@/hooks';
import { Centered as CenteredLayout, Main as MainLayout } from '@/layouts';
import { CHAT_BASE, chatThreadPath } from '@/pages/ChatPage/chatPaths';
import LoginPage from '@/pages/LoginPage';
import SignupPage from '@/pages/SignupPage';
import SplashPage from '@/pages/SplashPage';

const ChatPage = lazy(() => import('@/pages/ChatPage'));
const CommunicationPage = lazy(() => import('@/pages/CommunicationPage'));
const ConceptPage = lazy(() => import('@/pages/ConceptPage'));
const ConnectionPage = lazy(() => import('@/pages/ConnectionPage'));
const ContentPage = lazy(() => import('@/pages/ContentPage'));
const EventPage = lazy(() => import('@/pages/EventPage'));
const AsksPage = lazy(() => import('@/pages/AsksPage'));
const ForecastPage = lazy(() => import('@/pages/ForecastPage'));
const ItemPage = lazy(() => import('@/pages/ItemPage'));
const SourcesPage = lazy(() => import('@/pages/SourcesPage'));
const JobsPage = lazy(() => import('@/pages/JobsPage'));
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

function Providers({ children }: { children: ReactNode }) {
  return (
    <Router>
      <ThemeProvider defaultTheme="system" storageKey="vite-ui-theme">
        <BackgroundProvider>
          <DeviceLayoutProvider args={[]}>
            <ConnectionModeProvider args={[]}>
              {/* Inside ConnectionModeProvider: the outbox flush loop is driven by the
                  resolved connection mode rather than a timer of its own. */}
              <OutboxQueueProvider args={[]}>
                <AuthProvider args={[]}>
                  <FeaturesProvider args={[]}>
                    <ModelProvider args={[]}>
                      <CaptureModalProvider args={[]}>
                        <ApolloProvider>
                          <PowerSyncProvider>{children}</PowerSyncProvider>
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

  // Native pairing: `/device-connect` is Portal cloud-connect; `/server` is the
  // Advanced URL fallback. iOS always uses cloud-connect (a leftover docker/LAN
  // origin does not skip it). `/connect` is Sources and must not be used here.
  useEffect(() => {
    const pairing = location.pathname === '/device-connect' || location.pathname === '/server';

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
              {/* Native: Safari / cold start always reopens `/`. The marketing
                  splash is web-only; the phone's first screen is cloud-connect. */}
              {isNativePlatform() ? <Navigate to="/device-connect" replace /> : <SplashPage />}
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

        <Route element={<CenteredLayout />}>
          <Route path="/device-connect" element={<DeviceConnectPage />} />
          <Route path="/server" element={<ServerSettingsPage />} />

          <Route
            path="/login"
            element={
              // Native shells always cloud-connect. Restoring `/login` from an
              // earlier hop (or an Android deep-link cold start) used to drop
              // Portal PKCE that only DeviceConnectPage resumes.
              isNativePlatform() ? (
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
          <Route path="/today/:id?" element={<RedirectToCalendar />} />

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

          {/* `/memory` is the unfiltered explorer (all kinds). `/memory/events`
              is the same page with the Events submenu's type filter. */}
          <Route
            path="/memory"
            element={
              <ProtectedRoute>
                <MemoryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/memory/events"
            element={
              <ProtectedRoute>
                <MemoryPage />
              </ProtectedRoute>
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
          <Route path="/inventory" element={<Navigate to="/memory/things" replace />} />
          <Route
            path="/memory/things"
            element={
              <ProtectedRoute>
                <ThingsPage />
              </ProtectedRoute>
            }
          />

          <Route path="/receipts" element={<Navigate to="/memory/receipts" replace />} />
          <Route
            path="/memory/receipts"
            element={
              <ProtectedRoute>
                <ReceiptsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/receipts/:id"
            element={
              <ProtectedRoute>
                <ReceiptPage />
              </ProtectedRoute>
            }
          />

          {isFeatureEnabled('files.page') && (
            <>
              <Route path="/files" element={<Navigate to="/memory/content" replace />} />
              {/*
                The optional :contentId gives an individual content row a shareable
                URL and makes Back close the drawer. It is one route rather than two
                so ContentLibraryPage stays mounted when the param changes — a second
                route would remount it and throw away every page the user scrolled in.
              */}
              <Route
                path="/memory/content/:contentId?"
                element={
                  <ProtectedRoute>
                    <ContentLibraryPage />
                  </ProtectedRoute>
                }
              />
            </>
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
            <>
              <Route path="/tags" element={<Navigate to="/memory/tags" replace />} />
              <Route
                path="/memory/tags"
                element={
                  <ProtectedRoute>
                    <TagsPage />
                  </ProtectedRoute>
                }
              />
            </>
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
              destination. The old /chat/:id? address is kept as a redirect,
              declared here alongside the route it now points at, so a
              bookmark or an external deep-link still lands. */}
          {isFeatureEnabled('chat.page') && (
            <>
              <Route
                path="/memory/chat/:id?"
                element={
                  <ProtectedRoute>
                    <ChatPage />
                  </ProtectedRoute>
                }
              />
              <Route path="/chat/:id?" element={<RedirectToChat />} />
            </>
          )}

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
              list moves under /memory/*, the old address stays as a redirect
              for whatever already links here. The detail/edit page keeps its
              own top-level path, same as /people/:id and /receipts/:id. */}
          <Route path="/notes" element={<Navigate to="/memory/notes" replace />} />
          <Route
            path="/memory/notes"
            element={
              <ProtectedRoute>
                <NotesPage />
              </ProtectedRoute>
            }
          />

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
            path="/memory/people"
            element={
              <ProtectedRoute>
                <PeoplePage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/people/:id"
            element={
              <ProtectedRoute>
                <PersonPage />
              </ProtectedRoute>
            }
          />

          <Route path="/places" element={<Navigate to="/memory/places" replace />} />
          {/* The optional :placeId gives a place row a shareable URL and makes
              Back close its drawer — same shape as /memory/content/:contentId. */}
          <Route
            path="/memory/places/:placeId?"
            element={
              <ProtectedRoute>
                <PlacesPage />
              </ProtectedRoute>
            }
          />

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
