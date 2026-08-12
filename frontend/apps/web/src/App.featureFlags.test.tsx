import { type ReactNode } from 'react';

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from './App';

// Companion to App.test.tsx, which stubs `useFeatures` to drive the fallback
// directly. This one leaves the real hook, the real provider and the real route
// table in place and stubs only the network, so it also pins the handover
// between them: the moment `loading` goes false, `isFeatureEnabled` must already
// know about the flags, or the fallback would still paint a 404 on the way past.
const h = vi.hoisted(() => ({ notFoundRenders: 0 }));

// The bug was a *transient* render, so asserting on the DOM at a few sampled
// moments can miss it — the flags settle across two independent fetches, and a
// 404 committed between them would be gone by the next assertion. Count renders
// instead: this catches the page appearing at any point in the load.
vi.mock('@/components/NotFound', () => ({
  default: () => {
    h.notFoundRenders += 1;

    return <div>Sorry, the page you are looking for was not found.</div>;
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => [
    {
      expired: false,
      authToken: 'test-token',
      authenticated: true,
      loading: false,
      initializing: false,
      error: null,
    },
    { login: vi.fn(), logout: vi.fn(), signup: vi.fn() },
  ],
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { id: '1', name: 'Test', email: 'test@example.com', onboarded: true },
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/useLocationTracking', () => ({
  useLocationTracking: () => {},
  isLocationTrackingEnabled: () => false,
}));

vi.mock('@/components/ThemePicker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ThemePicker')>();

  return {
    ...actual,
    ColorPicker: () => null,
    TexturePicker: () => null,
    ThemeProvider: ({ children }: { children: ReactNode }) => children,
    BackgroundProvider: ({ children }: { children: ReactNode }) => children,
    useTheme: () => ({ themeState: { mode: 'light' }, setTheme: vi.fn() }),
  };
});

vi.mock('@/api/ApolloProvider', async () => {
  const {
    ApolloClient,
    ApolloLink,
    ApolloProvider: Provider,
    InMemoryCache,
    Observable,
  } = await import('@apollo/client');

  const client = new ApolloClient({
    cache: new InMemoryCache(),
    link: new ApolloLink(() => new Observable(() => {})),
  });

  return {
    ApolloProvider: ({ children }: { children: ReactNode }) => (
      <Provider client={client}>{children}</Provider>
    ),
  };
});

// PowerSyncProvider eagerly opens a real on-device SQLite connection (a Web
// Worker under `@powersync/web`), which jsdom doesn't support — none of these
// route-shell assertions depend on it, so swap it for a passthrough, same as
// ApolloProvider above.
vi.mock('@/api/powersync/PowerSyncProvider', () => ({
  PowerSyncProvider: ({ children }: { children: ReactNode }) => children,
}));

function ok(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

function isFlagRequest(input: RequestInfo | URL) {
  return String(input).includes('/api/_internal/features');
}

/**
 * Hold both flag responses open so the window the bug lived in can be inspected,
 * then release them on demand. Everything else the app fetches on mount (models,
 * telemetry consent) answers immediately and emptily — it is not what is under test.
 */
function deferredFlags() {
  const release: Array<() => void> = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      if (!isFlagRequest(input)) {
        return Promise.resolve(ok([]));
      }

      return new Promise<Response>((resolve) => {
        const flags = String(input).endsWith('/global') ? {} : { 'stats.page': true };

        release.push(() => resolve(ok(flags)));
      });
    }),
  );

  return () => release.forEach((fn) => fn());
}

function notFound() {
  return screen.queryByText(/the page you are looking for was not found/i);
}

beforeEach(() => {
  h.notFoundRenders = 0;
  window.history.pushState({}, '', '/stats');
});

afterEach(() => vi.unstubAllGlobals());

describe('App feature-gated routes, end to end', () => {
  it('goes from load to the page without ever rendering 404', async () => {
    const releaseFlags = deferredFlags();

    render(<App />);

    // In flight: /stats is not in the route table yet, so "*" is what matches.
    expect(notFound()).not.toBeInTheDocument();

    releaseFlags();

    // Landed: the route exists and the layout mounts...
    expect(await screen.findByLabelText('Stats')).toBeInTheDocument();

    // ...and 404 was never rendered on the way there, not at any commit.
    expect(h.notFoundRenders).toBe(0);
  });

  it('renders 404 once the flags answer without the flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => Promise.resolve(ok(isFlagRequest(input) ? {} : []))),
    );

    render(<App />);

    await waitFor(() => expect(notFound()).toBeInTheDocument());
  });
});
