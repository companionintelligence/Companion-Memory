import { type ReactNode } from 'react';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_HUB_SECTIONS } from '@/components/MemoryHub';

import App from './App';

// Feature-gated routes (/self, /tags, …) are only added to the route
// table once `isFeatureEnabled` says yes, so a hard load of one of them matches
// the "*" fallback until the flags arrive. These tests pin the fallback's
// behaviour on both sides of that window.
// `enabled` answers for every flag at once, which is all most of these need.
// `off` names the exceptions, so a test can hold one flag against the rest —
// Self's route tree is gated on `self.page` while the Reflections tab inside
// it is gated on `insights.page`, and the interesting case is one without
// the other.
const h = vi.hoisted(() => ({
  features: { loading: true, enabled: false } as {
    loading: boolean;
    enabled: boolean;
    off?: string[];
  },
  signOutPrompt: { open: false, unsentCaptures: 0 },
  signedIn: true,
  // The session check went unanswered: no token yet, but nobody said "signed out".
  unreachable: false,
}));

vi.mock('@/common/feature', () => ({
  FeaturesProvider: ({ children }: { children: ReactNode }) => children,
  useFeatures: () => ({
    isFeatureEnabled: (flag: string) => h.features.enabled && !h.features.off?.includes(flag),
    loading: h.features.loading,
    refresh: async () => {},
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => [
    {
      expired: !h.signedIn,
      authToken: h.signedIn ? 'test-token' : null,
      authenticated: h.signedIn,
      loading: false,
      initializing: false,
      unreachable: h.unreachable,
      error: null,
      signOutPrompt: h.signOutPrompt,
    },
    { login: vi.fn(), logout: vi.fn(), confirmSignOut: vi.fn(), cancelSignOut: vi.fn(), signup: vi.fn() },
  ],
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: h.signedIn ? { id: '1', name: 'Test', email: 'test@example.com', onboarded: true } : null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/useLocationTracking', () => ({
  useLocationTracking: () => {},
  isLocationTrackingEnabled: () => false,
}));

// The theme providers drive a canvas animation jsdom cannot run, and none of
// these assertions depend on them. Everything else in the module stays real.
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

// The app-wide spinner, made findable. Everything else in the module stays real.
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  LoadingPage: () => <div data-testid="loading-page" />,
}));

// A client whose link never emits: the pages under test are asserted on their
// route matching, not their data, and a pending query is the quietest stand-in.
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

const GATED_PATHS = ['/self', '/tags'];

// The three addresses Reflections shipped under before it moved into Self.
const LEGACY_REFLECTIONS_PATHS = ['/prompts', '/memory/questions', '/memory/reflections'];

function renderAt(path: string, state?: unknown) {
  window.history.pushState(state ? { usr: state } : {}, '', path);

  return render(<App />);
}

function notFound() {
  return screen.queryByText(/the page you are looking for was not found/i);
}

beforeEach(() => {
  h.features = { loading: true, enabled: false };
  h.signOutPrompt = { open: false, unsentCaptures: 0 };
  h.signedIn = true;
  h.unreachable = false;
});

describe('signing out with captures that have not uploaded', () => {
  // The question belongs to sign-out, not to one page: every Log out reaches it.
  it('asks on whatever page the sign-out started from', async () => {
    h.features = { loading: false, enabled: true };
    h.signOutPrompt = { open: true, unsentCaptures: 2 };

    renderAt('/self');

    expect(await screen.findByRole('alertdialog')).toHaveTextContent("2 captures haven't uploaded yet");
  });
});

describe('the Memory hub', () => {
  // Every section the strip links to is a child of one layout route. A section
  // left outside it would tear the strip down on the way in. The pages never
  // get data here (the Apollo link never answers), which is also the case that
  // used to swap the whole page, strip included, for a spinner.
  it.each(
    MEMORY_HUB_SECTIONS.map((section) => [
      section.label,
      section.to === '/memory/events' ? '/memory/people' : '/memory/events?view=list',
    ]),
  )('keeps the same section strip when %s opens from another section (%s)', async (label, from) => {
    h.features = { loading: false, enabled: true };

    renderAt(from);

    const strip = await screen.findByRole('navigation', { name: 'Memory sections' });

    fireEvent.click(within(strip).getByRole('link', { name: label }));

    // A first visit shows its fallback at once (no transitions). That is
    // the section's skeleton, never the app-wide spinner.
    expect(screen.queryByTestId('loading-page')).not.toBeInTheDocument();

    await waitFor(() =>
      expect(within(strip).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page'),
    );
    expect(screen.getByRole('navigation', { name: 'Memory sections' })).toBe(strip);
  });
});

describe('App routing', () => {
  it.each(GATED_PATHS)('does not flash 404 on %s while the flags are loading', (path) => {
    const { container } = renderAt(path);

    // Paired with the absence check below: on its own, "no 404" would also pass
    // if the tree had failed to render at all.
    expect(container).not.toBeEmptyDOMElement();
    expect(notFound()).not.toBeInTheDocument();
  });

  // The settings overlay keeps the page it was opened over in `location.state`,
  // and the browser restores history state across a reload — so refreshing on
  // /settings/* re-renders that background route, gated flags and all.
  it('does not flash 404 when a settings overlay is reloaded over a gated page', () => {
    const { container } = renderAt('/settings/appearance', {
      backgroundLocation: { pathname: '/self', search: '', hash: '', state: null, key: 'test' },
    });

    expect(container).not.toBeEmptyDOMElement();
    expect(notFound()).not.toBeInTheDocument();
  });

  it.each(GATED_PATHS)('mounts %s under the main layout once the flags arrive enabled', async (path) => {
    const { rerender } = renderAt(path);

    h.features = { loading: false, enabled: true };
    rerender(<App />);

    // The layout's nav landmarks stand in for "off the fallback and into the
    // route" — the pages themselves load lazily and have nothing in common.
    expect(await screen.findAllByRole('navigation')).not.toHaveLength(0);
    expect(notFound()).not.toBeInTheDocument();
  });

  it.each(GATED_PATHS)('still renders 404 on %s when the flag is genuinely off', async (path) => {
    h.features = { loading: false, enabled: false };

    renderAt(path);

    await waitFor(() => expect(notFound()).toBeInTheDocument());
  });

  // Signed out, only the global flags are known, so the gated routes are not in the table.
  it.each(['/self', '/memory/chat', '/jobs'])(
    'sends a signed-out visitor at %s to Log In, keeping the path, instead of 404',
    async (path) => {
      h.signedIn = false;
      h.features = { loading: false, enabled: false };

      renderAt(path);

      await waitFor(() => expect(window.location.pathname).toBe('/login'));
      expect(window.history.state?.usr).toEqual({ from: path });
      expect(notFound()).not.toBeInTheDocument();
    },
  );

  // A reload while Memory cannot answer leaves no token and no per-user flags, so the
  // gated route is missing. Nobody signed out. Say Memory cannot be reached, as every
  // other signed-in page does, and keep the address.
  it.each(['/self', '/memory/chat', '/jobs'])(
    'says Memory cannot be reached at %s during an outage instead of sending the person to Log In',
    async (path) => {
      h.signedIn = false;
      h.unreachable = true;
      h.features = { loading: false, enabled: false };

      renderAt(path);

      expect(await screen.findByText("Can't reach Memory")).toBeInTheDocument();
      expect(window.location.pathname).toBe(path);
      expect(notFound()).not.toBeInTheDocument();
    },
  );

  it('renders 404 for an unknown path once the flags have loaded', async () => {
    h.features = { loading: false, enabled: true };

    renderAt('/no-such-page');

    await waitFor(() => expect(notFound()).toBeInTheDocument());
  });

  // `/connect`, `/connections` and `/import` were three destinations for one
  // intention; Sources is the merge. They stay as redirects so bookmarks, docs
  // and any link still in the wild keep working.
  describe('the routes Sources replaced', () => {
    it.each([
      ['/connect', '/sources/connect'],
      ['/connections', '/sources/connect'],
      ['/import', '/sources/import'],
    ])('redirects %s to %s', async (from, to) => {
      h.features = { loading: false, enabled: true };

      renderAt(from);

      await waitFor(() => expect(window.location.pathname).toBe(to));
      expect(notFound()).not.toBeInTheDocument();
    });

    // `/import` was flag-gated, and a gated route here is never registered
    // rather than blocked — so with the flag off it 404'd. Sources itself is
    // deliberately ungated: the connect half has to exist either way.
    it('keeps /sources reachable with every flag off', async () => {
      h.features = { loading: false, enabled: false };

      renderAt('/sources');

      await waitFor(() => expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0));
      expect(notFound()).not.toBeInTheDocument();
    });
  });

  // /stats, /settings/about-you, /settings/account, and the three old
  // addresses for Reflections ("Questions" at /prompts, then
  // /memory/questions, then /memory/reflections under the Memory hub) were
  // all folded into the Self tab. They stay as redirects so bookmarks and
  // links keep working.
  describe('the paths Self replaced', () => {
    it.each([
      ['/stats', '/self/stats'],
      ['/settings/about-you', '/self'],
      ['/settings/account', '/self'],
      ['/prompts', '/self/reflections'],
      ['/memory/questions', '/self/reflections'],
      ['/memory/reflections', '/self/reflections'],
      ['/profile', '/self/settings'],
      ['/profile/appearance', '/self/settings/appearance'],
    ])('redirects %s to %s', async (from, to) => {
      h.features = { loading: false, enabled: true };
      // On desktop /self/settings is only a stop on the way. ProfilePage sends it on to
      // the settings dialog, sometimes before the first check below runs. So record each
      // address the redirects write instead of sampling the last one.
      const replaced = vi.spyOn(window.history, 'replaceState');

      renderAt(from);

      await waitFor(() => expect(replaced.mock.calls.map(([, , url]) => url)).toContain(to));
      expect(notFound()).not.toBeInTheDocument();
    });

    it('redirects /stats to /self/stats', async () => {
      h.features = { loading: false, enabled: true };

      renderAt('/stats');

      await waitFor(() => expect(window.location.pathname).toBe('/self/stats'));
      expect(notFound()).not.toBeInTheDocument();
    });

    // /stats used to be registered UNCONDITIONALLY, on the reasoning that an
    // old bookmark should still land on Self "even with the flag off — it just
    // then hits Self's own fallback". That fallback lives inside SelfPage,
    // which the same flag stops mounting, so what actually happened was a 404
    // at /self/stats: an address the user never typed, reached by a redirect
    // that outlived its target. It now sits inside the gate with /prompts and
    // the rest, so the 404 — unavoidable with Self switched off — lands where
    // the user actually asked.
    it('404s at /stats itself, not at /self/stats, when Self is switched off', async () => {
      h.features = { loading: false, enabled: false };

      renderAt('/stats');

      await waitFor(() => expect(notFound()).toBeInTheDocument());
      expect(window.location.pathname).toBe('/stats');
    });

    // The Reflections redirects live inside the `self.page` gate with their
    // destination. Nothing in the app links to them any more (the Power Rail
    // points straight at /self/reflections, gated on `insights.page` — see
    // selfSections.ts), so what these pin is the bookmark case: an old link
    // arriving while the flags are unsettled, or with Self switched off.
    describe('the legacy Reflections addresses', () => {
      it.each(LEGACY_REFLECTIONS_PATHS)('holds %s while the flags are loading', (path) => {
        // `loading: true` from beforeEach: the redirect is not in the table
        // yet, so "*" takes it and paints the loading page. Redirecting here
        // would commit to a destination before knowing whether it exists.
        const { container } = renderAt(path);

        expect(container).not.toBeEmptyDOMElement();
        expect(notFound()).not.toBeInTheDocument();
        expect(window.location.pathname).toBe(path);
      });

      it.each(LEGACY_REFLECTIONS_PATHS)('redirects %s once the flags arrive enabled', async (path) => {
        const { rerender } = renderAt(path);

        h.features = { loading: false, enabled: true };
        rerender(<App />);

        await waitFor(() => expect(window.location.pathname).toBe('/self/reflections'));
        expect(notFound()).not.toBeInTheDocument();
      });

      // The combination that used to break: Reflections itself is on, but the
      // flag that registers the tree it now lives in is off. Ungated, these
      // bounced the user to /self/reflections — a path with no route behind
      // it — and 404'd there. The 404 is unavoidable with Self switched off;
      // landing it on the address the user actually opened is not.
      it.each(LEGACY_REFLECTIONS_PATHS)(
        'leaves %s where it is when self.page is off and insights.page is on',
        async (path) => {
          h.features = { loading: false, enabled: true, off: ['self.page'] };

          renderAt(path);

          await waitFor(() => expect(notFound()).toBeInTheDocument());
          expect(window.location.pathname).toBe(path);
        },
      );

      // The mirror of the above, and the reason the gate is `self.page` and
      // not `insights.page`: with Self registered, the redirect is right even
      // though the tab it points at is missing — SelfPage sends that miss back
      // to /self rather than 404ing.
      it.each(LEGACY_REFLECTIONS_PATHS)(
        'still redirects %s when insights.page is off but self.page is on',
        async (path) => {
          h.features = { loading: false, enabled: true, off: ['insights.page'] };

          renderAt(path);

          await waitFor(() => expect(window.location.pathname).toBe('/self'));
          expect(notFound()).not.toBeInTheDocument();
        },
      );
    });
  });
});
