import { type ReactNode, lazy } from 'react';

import { DeviceLayoutProvider } from '@ci/common';
import { BrowserRouter as Router, Routes, Route, useLocation, type Location } from 'react-router-dom';

import { ApolloProvider } from '@/api/ApolloProvider';
import { FeaturesProvider, useFeatures } from '@/common/feature';
import NotFoundPage from '@/components/NotFound';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { RedirectKnownUser } from '@/components/RedirectKnownUser';
import { ThemeProvider, BackgroundProvider } from '@/components/ThemePicker';
import { AuthProvider, CaptureModalProvider, ModelProvider, usePreventOverscroll } from '@/hooks';
import { Centered as CenteredLayout, Main as MainLayout } from '@/layouts';
import FeedPage from '@/pages/FeedPage';
import LoginPage from '@/pages/LoginPage';
import SignupPage from '@/pages/SignupPage';
import SplashPage from '@/pages/SplashPage';

const ChatPage = lazy(() => import('@/pages/ChatPage'));
const CommunicationPage = lazy(() => import('@/pages/CommunicationPage'));
const ConceptPage = lazy(() => import('@/pages/ConceptPage'));
const ConnectPage = lazy(() => import('@/pages/ConnectPage'));
const ConnectionPage = lazy(() => import('@/pages/ConnectionPage'));
const ConnectionsPage = lazy(() => import('@/pages/ConnectionsPage'));
const ContentPage = lazy(() => import('@/pages/ContentPage'));
const EventPage = lazy(() => import('@/pages/EventPage'));
const ItemPage = lazy(() => import('@/pages/ItemPage'));
const InsightsPage = lazy(() => import('@/pages/InsightsPage'));
const JobsPage = lazy(() => import('@/pages/JobsPage'));
const InventoryPage = lazy(() => import('@/pages/InventoryPage'));
const MemoryPage = lazy(() => import('@/pages/MemoryPage'));
const NotePage = lazy(() => import('@/pages/NotePage'));
const NotesPage = lazy(() => import('@/pages/NotesPage'));
const OAuthCallbackPage = lazy(() => import('@/pages/OAuthCallbackPage'));
const OnboardingPage = lazy(() => import('@/pages/OnboardingPage'));
const OpenIDCallbackPage = lazy(() => import('@/pages/OpenIDCallbackPage'));
const PersonPage = lazy(() => import('@/pages/PersonPage'));
const PlacePage = lazy(() => import('@/pages/PlacePage'));
const ProviderPage = lazy(() => import('@/pages/ProviderPage'));
const SearchPage = lazy(() => import('@/pages/SearchPage'));
const FilesPage = lazy(() => import('@/pages/FilesPage'));
const SavedSearchesPage = lazy(() => import('@/pages/SavedSearchesPage'));
const SharedSearchPage = lazy(() => import('@/pages/SharedSearchPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const SummaryDetailPage = lazy(() => import('@/pages/SummaryDetailPage'));
const SystemPage = lazy(() => import('@/pages/SystemPage'));
const PromptsPage = lazy(() => import('@/pages/PromptsPage'));

function Providers({ children }: { children: ReactNode }) {
  return (
    <Router>
      <ThemeProvider defaultTheme="system" storageKey="ci-ui-theme">
        <BackgroundProvider>
          <DeviceLayoutProvider args={[]}>
            <AuthProvider args={[]}>
              <FeaturesProvider args={[]}>
                <ModelProvider args={[]}>
                  <CaptureModalProvider args={[]}>
                    <ApolloProvider>{children}</ApolloProvider>
                  </CaptureModalProvider>
                </ModelProvider>
              </FeaturesProvider>
            </AuthProvider>
          </DeviceLayoutProvider>
        </BackgroundProvider>
      </ThemeProvider>
    </Router>
  );
}

function AppRoutes() {
  const { isFeatureEnabled } = useFeatures();
  const location = useLocation();
  const backgroundLocation = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

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

        <Route element={<CenteredLayout />}>
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

        <Route element={<MainLayout />}>
          {/* Intelligence */}
          <Route
            path="/feed/:id?"
            element={
              <ProtectedRoute>
                <FeedPage />
              </ProtectedRoute>
            }
          />

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
                <MemoryPage />
              </ProtectedRoute>
            }
          />

          {isFeatureEnabled('enable.inventory.page') && (
            <Route
              path="/inventory"
              element={
                <ProtectedRoute>
                  <InventoryPage />
                </ProtectedRoute>
              }
            />
          )}

          <Route
            path="/insights"
            element={
              <ProtectedRoute>
                {isFeatureEnabled('new.insights.page') && <InsightsPage />}
                {!isFeatureEnabled('new.insights.page') && <PromptsPage />}
              </ProtectedRoute>
            }
          />

          <Route
            path="/insights/:id"
            element={
              <ProtectedRoute>
                <SummaryDetailPage />
              </ProtectedRoute>
            }
          />

          {isFeatureEnabled('files.page') && (
            <Route
              path="/files"
              element={
                <ProtectedRoute>
                  <FilesPage />
                </ProtectedRoute>
              }
            />
          )}

          <Route
            path="/chat/:id?"
            element={
              <ProtectedRoute>
                <ChatPage />
              </ProtectedRoute>
            }
          />

          {/* Admin / System */}
          <Route
            path="/jobs"
            element={
              <ProtectedRoute>
                <JobsPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/connect"
            element={
              <ProtectedRoute>
                <ConnectPage />
              </ProtectedRoute>
            }
          />

          <Route
            path="/connections"
            element={
              <ProtectedRoute>
                <ConnectionsPage />
              </ProtectedRoute>
            }
          />

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

          <Route
            path="/people/:id"
            element={
              <ProtectedRoute>
                <PersonPage />
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

          {isFeatureEnabled('new.insights.page') && (
            <Route
              path="/prompts"
              element={
                <ProtectedRoute>
                  <PromptsPage />
                </ProtectedRoute>
              }
            />
          )}
        </Route>

        {/* Fallback */}
        <Route path="*" element={<NotFoundPage />} />
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
