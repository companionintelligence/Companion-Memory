import { type ReactNode, Suspense, lazy, useEffect } from 'react';

import {
  ConnectionModeProvider,
  DeviceLayoutProvider,
  LoadingPage,
  OutboxQueueProvider,
  getApiBaseUrl,
  isNativePlatform,
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
} from '@/hooks';
import { Centered as CenteredLayout, Main as MainLayout } from '@/layouts';
import LoginPage from '@/pages/LoginPage';
import SignupPage from '@/pages/SignupPage';
import SplashPage from '@/pages/SplashPage';

const AppletPairPage = lazy(() => import('@/pages/AppletPairPage'));
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const CommunicationPage = lazy(() => import('@/pages/CommunicationPage'));
const ConceptPage = lazy(() => import('@/pages/ConceptPage'));
const ConnectionPage = lazy(() => import('@/pages/ConnectionPage'));
const ContentPage = lazy(() => import('@/pages/ContentPage'));
const EventPage = lazy(() => import('@/pages/EventPage'));
const ForecastPage = lazy(() => import('@/pages/ForecastPage'));
const ItemPage = lazy(() => import('@/pages/ItemPage'));
const SourcesPage = lazy(() => import('@/pages/SourcesPage'));
const JobsPage = lazy(() => import('@/pages/JobsPage'));
const InventoryPage = lazy(() => import('@/pages/InventoryPage'));
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
const SearchPage = lazy(() => import('@/pages/SearchPage'));
const FilesPage = lazy(() => import('@/pages/FilesPage'));
const SavedSearchesPage = lazy(() => import('@/pages/SavedSearchesPage'));
const ServerSettingsPage = lazy(() => import('@/pages/ServerSettingsPage'));
const DeviceConnectPage = lazy(() => import('@/pages/DeviceConnectPage'));
const SharedSearchPage = lazy(() => import('@/pages/SharedSearchPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const StatsPage = lazy(() => import('@/pages/StatsPage'));
const TagsPage = lazy(() => import('@/pages/TagsPage'));
// Pulls SchedulePage and FeedPage in with it — neither is routed on its own.
const TodayPage = lazy(() => import('@/pages/TodayPage'));
const SummaryDetailPage = lazy(() => import('@/pages/SummaryDetailPage'));
const SystemPage = lazy(() => import('@/pages/SystemPage'));
const PromptsPage = lazy(() => import('@/pages/PromptsPage'));

function RedirectInsightsSummary() {
  const { id } = useParams<{ id: string }>();

  return <Navigate to={`/brief/summaries/${id ?? ''}`} replace />;
}

/**
 * The brief now lives inside Today, so both of its old addresses land there.
 *
 * Aimed at /today rather than chained through /brief, which would cost a second
 * redirect on every old link. The action id is carried across because the
 * brief's cards deep-link by it — dropping it would open the page but not the
 * card someone was sent.
 */
function RedirectToToday() {
  const { id } = useParams<{ id?: string }>();

  return <Navigate to={id ? `/today/${id}` : '/today'} replace />;
}

function RedirectFeedSummaryToBrief() {
  const { id } = useParams<{ id: string }>();

  return <Navigate to={`/brief/summaries/${id ?? ''}`} replace />;
}

/** Events explorer moved to /memory/events; keep query (view=, filters) intact. */
function RedirectMemoryToEvents() {
  const { search } = useLocation();

  return <Navigate to={{ pathname: '/memory/events', search }} replace />;
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

  // Browser location tracking (issue #1811): records ci.position fixes while
  // the user has enabled it in Settings -> Location. Inert when disabled.
  useLocationTracking();

  // On the native app the API origin must be configured before anything else can
  // load. Route to `/device-connect` (Portal picker). `/server` is Advanced URL
  // entry. `/connect` is Sources and must not be used here.
  useEffect(() => {
    const pairing = location.pathname === '/device-connect' || location.pathname === '/server';

    if (isNativePlatform() && !getApiBaseUrl() && !pairing) {
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
              <SplashPage />
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

        {/*
          Where CI-Capture (and any other client) sends the user to approve a
          pairing request: /pair?token=<pairing token>, handled by
          POST /api/pairing/complete. Deliberately not wrapped in ProtectedRoute —
          the page runs its own auth check so it can carry the pairing token
          through the sign-in round-trip, which a bounce to /login would drop. It
          paints its own full-screen centered card, so it stays outside
          CenteredLayout too; only the Suspense boundary for the lazy chunk is
          needed here.
        */}
        <Route
          path="/pair"
          element={
            <Suspense fallback={<LoadingPage />}>
              <AppletPairPage />
            </Suspense>
          }
        />

        <Route element={<CenteredLayout />}>
          <Route path="/device-connect" element={<DeviceConnectPage />} />
          <Route path="/server" element={<ServerSettingsPage />} />

          <Route
            path="/login"
            element={
              <RedirectKnownUser>
                <LoginPage />
              </RedirectKnownUser>
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

          <Route
            path="/today/:id?"
            element={
              <ProtectedRoute>
                <TodayPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/forecast"
            element={
              <ProtectedRoute>
                <ForecastPage />
              </ProtectedRoute>
            }
          />

          {/* Both former destinations now resolve to the page that absorbed
              them. /brief/summaries/:id is declared above and is more specific,
              so it still reaches the summary detail page. */}
          <Route path="/brief/:id?" element={<RedirectToToday />} />
          <Route path="/schedule" element={<RedirectToToday />} />

          <Route path="/feed/summaries/:id" element={<RedirectFeedSummaryToBrief />} />
          <Route path="/feed/:id?" element={<RedirectToToday />} />

          <Route
            path="/search"
            element={
              <ProtectedRoute>
                <SearchPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/memory"
            element={
              <ProtectedRoute>
                <RedirectMemoryToEvents />
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

          {isFeatureEnabled('enable.inventory.page') && (
            <>
              <Route path="/inventory" element={<Navigate to="/memory/things" replace />} />
              <Route
                path="/memory/things"
                element={
                  <ProtectedRoute>
                    <InventoryPage />
                  </ProtectedRoute>
                }
              />
            </>
          )}

          {isFeatureEnabled('files.page') && (
            <>
              <Route path="/files" element={<Navigate to="/memory/content" replace />} />
              {/*
                The optional :fileId gives an individual file a shareable URL and
                makes Back close the viewer. It is one route rather than two so
                FilesPage stays mounted when the param changes — a second route
                would remount it and throw away every page the user scrolled in.
              */}
              <Route
                path="/memory/content/:fileId?"
                element={
                  <ProtectedRoute>
                    <FilesPage />
                  </ProtectedRoute>
                }
              />
            </>
          )}

          <Route path="/insights" element={<Navigate to="/today" replace />} />
          <Route
            path="/insights/:id"
            element={
              <ProtectedRoute>
                <RedirectInsightsSummary />
              </ProtectedRoute>
            }
          />

          {isFeatureEnabled('insights.page') && (
            <>
              {/*
                "Questions" is what this page used to be called; it is
                "Reflections" in the UI now. Both old paths stay as redirects so
                bookmarks, docs and any link still in the wild keep working.
              */}
              <Route path="/prompts" element={<Navigate to="/memory/reflections" replace />} />
              <Route path="/memory/questions" element={<Navigate to="/memory/reflections" replace />} />
              <Route
                path="/memory/reflections"
                element={
                  <ProtectedRoute>
                    <PromptsPage />
                  </ProtectedRoute>
                }
              />
            </>
          )}

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

          {isFeatureEnabled('stats.page') && (
            <Route
              path="/stats"
              element={
                <ProtectedRoute>
                  <StatsPage />
                </ProtectedRoute>
              }
            />
          )}

          <Route path="/memory/knowledge" element={<Navigate to="/memory/events?view=graph" replace />} />

          {isFeatureEnabled('chat.page') && (
            <Route
              path="/chat/:id?"
              element={
                <ProtectedRoute>
                  <ChatPage />
                </ProtectedRoute>
              }
            />
          )}

          {/* Admin / System */}
          {isFeatureEnabled('jobs.page') && (
            <Route
              path="/jobs"
              element={
                <ProtectedRoute>
                  <JobsPage />
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

          <Route
            path="/settings/*"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/system"
            element={
              <ProtectedRoute>
                <SystemPage />
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

          {isFeatureEnabled('planning.page') && (
            <Route
              path="/plan"
              element={
                <ProtectedRoute>
                  <PlanPage />
                </ProtectedRoute>
              }
            />
          )}

          <Route
            path="/notes"
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
            path="/saved-searches?"
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
          <Route
            path="/memory/places"
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
          them (/stats, /tags, /prompts, or a settings overlay whose restored
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
