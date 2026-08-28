import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { SelfPage } from './SelfPage';

// Each tab body already has its own test coverage (AccountSection.test.tsx —
// now rendered inside SelfProfileTab, StatsPage.test.tsx, AboutYouSection/
// PersonForm inside SelfProfileTab, and PromptsPage's own reflections tests).
// What's unique to this file is the route composition (navigation itself
// lives in the Power Rail's SelfSubmenu, covered by SecondaryNavigation.test.tsx),
// so the bodies are stubbed to keep this focused and free of their own
// dependencies (Apollo mocks, auth mocks, stats service mocks).
vi.mock('./SelfProfileTab', () => ({
  SelfProfileTab: () => <div>profile-tab-body</div>,
}));
vi.mock('@/pages/ProfilePage/ProfilePage', () => ({
  ProfilePage: () => <div>settings-hub-body</div>,
}));
vi.mock('@/pages/StatsPage/StatsPage', () => ({
  StatsPage: () => <div>stats-tab-body</div>,
}));
vi.mock('@/pages/PromptsPage/PromptsPage', () => ({
  PromptsPage: () => <div>reflections-tab-body</div>,
}));
// `isFeatureEnabled` reports every flag as off until the flag fetches settle,
// so the loading case has to be steerable here — it is the difference between
// "reflections is off" and "we don't know yet".
const features = vi.hoisted(() => ({ enabled: true, loading: false }));
vi.mock('@/common/feature', () => ({
  useFeatures: () => ({
    isFeatureEnabled: () => features.enabled,
    loading: features.loading,
  }),
}));

beforeEach(() => {
  features.enabled = true;
  features.loading = false;
});

function renderAt(route: string) {
  return renderWithProviders(<SelfPage />, { route, path: '/self/*' });
}

describe('SelfPage', () => {
  it('shows the Profile body at /self', () => {
    renderAt('/self');

    expect(screen.getByText('profile-tab-body')).toBeInTheDocument();
  });

  it('shows the Stats body at /self/stats', () => {
    renderAt('/self/stats');

    expect(screen.getByText('stats-tab-body')).toBeInTheDocument();
  });

  it('shows the Reflections body at /self/reflections', () => {
    renderAt('/self/reflections');

    expect(screen.getByText('reflections-tab-body')).toBeInTheDocument();
  });

  it('shows the settings hub at /self/settings', () => {
    renderAt('/self/settings');

    expect(screen.getByText('settings-hub-body')).toBeInTheDocument();
  });

  // Account was its own destination before it was folded into the bottom of
  // Profile — old bookmarks should still land somewhere real, not a blank page.
  it('redirects the retired /self/account back to Profile', () => {
    renderAt('/self/account');

    expect(screen.getByText('profile-tab-body')).toBeInTheDocument();
  });

  it('redirects an unknown sub-path back to Profile', () => {
    renderAt('/self/nonsense');

    expect(screen.getByText('profile-tab-body')).toBeInTheDocument();
  });

  // Every flag reads as off until the flag fetches settle, so `reflections` is
  // genuinely missing from the table for the first frames. Redirecting on that
  // bounced anyone arriving at /self/reflections cold — a deep link, or the
  // phone restoring its last route — to /self with `replace`, and the
  // destination was gone by the time the flags landed.
  it('waits for the feature flags instead of redirecting /self/reflections away', () => {
    features.enabled = false;
    features.loading = true;

    renderAt('/self/reflections');

    expect(screen.queryByText('profile-tab-body')).not.toBeInTheDocument();
    expect(screen.queryByText('reflections-tab-body')).not.toBeInTheDocument();
  });

  it('redirects /self/reflections to Profile once the flags say the route is off', () => {
    features.enabled = false;
    features.loading = false;

    renderAt('/self/reflections');

    expect(screen.getByText('profile-tab-body')).toBeInTheDocument();
  });
});
