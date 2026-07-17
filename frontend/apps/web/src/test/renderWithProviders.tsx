import { type ReactElement, type ReactNode } from 'react';

import { InMemoryCache } from '@apollo/client';
import { MockedProvider, type MockedResponse } from '@apollo/client/testing';
import { DeviceLayoutProvider } from '@ci/common';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import { ThemeProvider, BackgroundProvider } from '@/components/ThemePicker';
import introspectionResult from '@/graphql/possibleTypes';
import { CaptureModalProvider } from '@/hooks';

export interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Initial router entry (e.g. `/memory?view=list`). Defaults to `/`. */
  route?: string;
  /** Multiple initial entries; overrides `route` when provided. */
  routerEntries?: string[];
  /** Apollo mocked GraphQL responses. */
  mocks?: readonly MockedResponse[];
  /** Wrap with Theme/Background providers (off by default — the Conway texture
   *  runs timers and most components don't need theme context). */
  withTheme?: boolean;
  /**
   * When set, render the UI under a matching route path so `useParams()` /
   * route matching works (e.g. path `/people/:id` with route `/people/42`).
   */
  path?: string;
}

/**
 * Compose the providers domain components require, with the network layer
 * stubbed. NOTE: Auth / Features / Model context are intentionally NOT provided
 * here — they fetch on mount. Tests for components that consume them should
 * `vi.mock('@/hooks/useAuth')` (and `@/common/feature`, `@/hooks/useModel`) to
 * supply deterministic values. See existing component tests for the pattern.
 */
function buildWrapper(options: RenderWithProvidersOptions) {
  const { route = '/', routerEntries, mocks = [], withTheme = false, path } = options;

  const cache = new InMemoryCache({ possibleTypes: introspectionResult.possibleTypes });

  return function Wrapper({ children }: { children: ReactNode }) {
    const routed = path ? (
      <Routes>
        <Route path={path} element={children} />
      </Routes>
    ) : (
      children
    );

    const tree = (
      <MemoryRouter initialEntries={routerEntries ?? [route]}>
        <DeviceLayoutProvider args={[]}>
          <CaptureModalProvider args={[]}>
            {/* Apollo 3.14 removed the `addTypename` prop; the cache adds
                __typename, and our mocks carry it via makeFragmentData. */}
            <MockedProvider mocks={mocks} cache={cache}>
              {routed}
            </MockedProvider>
          </CaptureModalProvider>
        </DeviceLayoutProvider>
      </MemoryRouter>
    );

    if (!withTheme) {
      return tree;
    }

    return (
      <ThemeProvider defaultTheme="light" storageKey="ci-ui-theme-test">
        <BackgroundProvider>{tree}</BackgroundProvider>
      </ThemeProvider>
    );
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult {
  const { route, routerEntries, mocks, withTheme, path, ...rtlOptions } = options;

  return render(ui, {
    wrapper: buildWrapper({ route, routerEntries, mocks, withTheme, path }),
    ...rtlOptions,
  });
}
