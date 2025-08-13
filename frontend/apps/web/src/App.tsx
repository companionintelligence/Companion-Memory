import { type ReactNode, lazy } from 'react';

import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AuthProvider, ModelProvider } from '@/hooks';
import { Centered as CenteredLayout, Main as MainLayout } from '@/layouts';
import LoginPage from '@/pages/LoginPage';
import NotFound from '@/pages/NotFound';
import SplashPage from '@/pages/SplashPage';

const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'));
const CapturePage = lazy(() => import('@/pages/CapturePage'));
const ChatPage = lazy(() => import('@/pages/ChatPage'));
const ConnectionsPage = lazy(() => import('@/pages/ConnectionsPage'));
const FilesGalleryPage = lazy(() => import('@/pages/FilesGalleryPage'));
const InsightsPage = lazy(() => import('@/pages/InsightsPage'));
const MemoryPage = lazy(() => import('@/pages/MemoryPage'));
const OAuthCallbackPage = lazy(() => import('@/pages/OAuthCallbackPage'));
const SearchPage = lazy(() => import('@/pages/SearchPage'));

function Providers({ children }: { children: ReactNode }) {
  return (
    <Router>
      <AuthProvider args={[]}>
        <ModelProvider args={[]}>{children}</ModelProvider>
      </AuthProvider>
    </Router>
  );
}

function AppRoutes() {
  return (
    <Routes>
      {/* No navigation for these pages */}
      <Route path="/" element={<SplashPage />} />

      <Route element={<CenteredLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
      </Route>

      {/* Main layout routes */}
      <Route element={<MainLayout />}>
        {/* Intelligence */}
        <Route
          path="/feed"
          element={
            <ProtectedRoute>
              <div>Feed page</div>
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
              <div>Actions page</div>
            </ProtectedRoute>
          }
        />
        <Route
          path="/chat/*"
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
        <Route
          path="/capture"
          element={
            <ProtectedRoute>
              <CapturePage />
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
              <div>Jobs page</div>
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
              <div>Settings page</div>
            </ProtectedRoute>
          }
        />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <Providers>
      <AppRoutes />
    </Providers>
  );
}
