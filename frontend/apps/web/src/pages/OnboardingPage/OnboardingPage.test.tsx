import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OnboardingPage } from './OnboardingPage';

/**
 * Regression cover for the trust dial reading as unclickable.
 *
 * The step's value came from `form.watch('trust_mode')` called *inside* the
 * `useMemo` that builds the step element, with only `[currentStepKey, form,
 * setTrustMode]` as dependencies. Watching during render does subscribe, so a click
 * re-rendered the page — but every dependency was referentially stable, so the memo
 * handed back the element built from the first value and the selection never moved.
 * The click handler had always been wired; the state it produced was simply never
 * rendered.
 *
 * These assertions go through the real page (not TrustDialStep in isolation) because
 * the defect lived entirely in the page's memo wiring — a component-level test would
 * have passed against the broken build.
 */

const h = vi.hoisted(() => ({
  saveProgress: vi.fn(async () => {}),
  fetchProgress: vi.fn(async () => ({
    // Start on the trust step so the test doesn't depend on the step ordering.
    stepKey: 'trust-dial' as const,
    draft: {},
    updatedAt: null,
  })),
}));

vi.mock('./useOnboardingProgress', () => ({
  useOnboardingProgress: () => ({
    loading: false,
    error: null,
    fetchProgress: h.fetchProgress,
    saveProgress: h.saveProgress,
  }),
}));

vi.mock('@/hooks', () => ({
  useCurrentUser: () => ({
    user: { id: 'u1', email: 'jsmith@example.com', name: 'J Smith', onboarded: false },
    loading: false,
    error: undefined,
  }),
  // Advancing off the trust step lands on RunFirstSyncStep, which reads this.
  useAuth: () => [{ authToken: 'test-token' }, { logout: vi.fn() }],
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => false }),
}));

// Pulls in the theme context, which this page does not otherwise need.
vi.mock('@/components/ThemePicker', () => ({
  ThemeToggle: () => <button type="button">Toggle theme</button>,
}));

function trustOption(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

describe('OnboardingPage trust dial', () => {
  it('moves the selection to the clicked option', async () => {
    render(<OnboardingPage />);

    await waitFor(() => expect(screen.getByText('How much trust?')).toBeInTheDocument());

    // Seeded from DEFAULT_FORM_VALUES.
    expect(trustOption('Balanced')).toHaveAttribute('aria-pressed', 'true');
    expect(trustOption('Cautious')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(trustOption('Cautious'));

    // Against the stale-memo bug this stayed on Balanced.
    await waitFor(() => expect(trustOption('Cautious')).toHaveAttribute('aria-pressed', 'true'));
    expect(trustOption('Balanced')).toHaveAttribute('aria-pressed', 'false');
    expect(trustOption('Hands-off')).toHaveAttribute('aria-pressed', 'false');
  });

  it('persists the chosen mode when advancing', async () => {
    render(<OnboardingPage />);

    await waitFor(() => expect(screen.getByText('How much trust?')).toBeInTheDocument());

    fireEvent.click(trustOption('Hands-off'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(h.saveProgress).toHaveBeenCalled());
    const [, draft] = h.saveProgress.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
    expect(draft.trust_mode).toBe('hands_off');
  });
});
