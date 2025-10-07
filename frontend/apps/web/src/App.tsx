import { type ReactNode, lazy } from 'react';

import { DeviceLayoutProvider } from '@ci/common';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

import NotFoundPage from '@/components/NotFound';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { RedirectKnownUser } from '@/components/RedirectKnownUser';
import {
  AuthProvider,
  CaptureModalProvider,
  ModelProvider,
  ThemeProvider,
  usePreventOverscroll,
} from '@/hooks';
import { Centered as CenteredLayout, Main as MainLayout } from '@/layouts';
import FeedPage from '@/pages/FeedPage';
import LoginPage from '@/pages/LoginPage';
import SignupPage from '@/pages/SignupPage';
import SplashPage from '@/pages/SplashPage';

const ActionsPage = lazy(() => import('@/pages/ActionsPage'));
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const ConnectPage = lazy(() => import('@/pages/ConnectPage'));
const ConnectionsPage = lazy(() => import('@/pages/ConnectionsPage'));
const FilesGalleryPage = lazy(() => import('@/pages/FilesGalleryPage'));
const InsightsPage = lazy(() => import('@/pages/InsightsPage'));
const JobsPage = lazy(() => import('@/pages/JobsPage'));
const MemoryPage = lazy(() => import('@/pages/MemoryPage'));
const OAuthCallbackPage = lazy(() => import('@/pages/OAuthCallbackPage'));
const OnboardingPage = lazy(() => import('@/pages/OnboardingPage'));
const SearchPage = lazy(() => import('@/pages/SearchPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const SystemPage = lazy(() => import('@/pages/SystemPage'));
const ToolsPage = lazy(() => import('@/pages/ToolsPage'));

function Providers({ children }: { children: ReactNode }) {
  return (
    <Router>
      <ThemeProvider defaultTheme="system" storageKey="ci-ui-theme">
        <DeviceLayoutProvider args={[]}>
          <AuthProvider args={[]}>
            <ModelProvider args={[]}>
              <CaptureModalProvider args={[]}>{children}</CaptureModalProvider>
            </ModelProvider>
          </AuthProvider>
        </DeviceLayoutProvider>
      </ThemeProvider>
    </Router>
  );
}

function AppRoutes() {
  return (
    <Routes>
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

        <Route
          path="/insights"
          element={
            <ProtectedRoute>
              <InsightsPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/actions"
          element={
            <ProtectedRoute>
              <ActionsPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/chat/:id?"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />

        <Route
          path="/files"
          element={
            <ProtectedRoute>
              <FilesGalleryPage />
            </ProtectedRoute>
          }
        />

        {/* Admin / System */}
        <Route
          path="/analytics"
          element={
            <ProtectedRoute>
              <AnalyticsPage />
            </ProtectedRoute>
          }
        />

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
          path="/settings"
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
          path="/tools"
          element={
            <ProtectedRoute>
              <ToolsPage />
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
      </Route>

      {/* Fallback */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
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
