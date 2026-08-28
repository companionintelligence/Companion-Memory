import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OnboardingStepKey } from './constants';
import { OnboardingPage } from './OnboardingPage';

const h = vi.hoisted(() => ({
  saveProgress: vi.fn(async () => {}),
  fetchProgress: vi.fn(async () => ({
    stepKey: 'connect-source' as OnboardingStepKey,
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
  useAuth: () => [{ authToken: 'test-token' }, { logout: vi.fn() }],
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({
    isFeatureEnabled: (key: string) => key === 'import.page',
  }),
}));

vi.mock('@/components/ThemePicker', () => ({
  ThemeToggle: () => <button type="button">Toggle theme</button>,
}));

vi.mock('./ConnectSourceStep', () => ({
  ConnectSourceStep: () => <div data-testid="connect-source-body">Connect sources</div>,
}));

vi.mock('./ImportArchivesStep', () => ({
  ImportArchivesStep: () => <div data-testid="import-archives-body">Import archives</div>,
}));

function mockStep(stepKey: OnboardingStepKey) {
  h.fetchProgress.mockResolvedValue({
    stepKey,
    draft: {},
    updatedAt: null,
  });
}

describe('OnboardingPage source-step navigation', () => {
  it('puts Next inside the page scroller on connect-source', async () => {
    mockStep('connect-source');
    render(<OnboardingPage />);

    expect(await screen.findByTestId('connect-source-body')).toBeInTheDocument();
    const scroll = screen.getByTestId('onboarding-scroll');
    expect(scroll).toContainElement(screen.getByTestId('onboarding-nav'));
  });

  it('puts Next inside the page scroller on import-archives', async () => {
    mockStep('import-archives');
    render(<OnboardingPage />);

    expect(await screen.findByTestId('import-archives-body')).toBeInTheDocument();
    const scroll = screen.getByTestId('onboarding-scroll');
    expect(scroll).toContainElement(screen.getByTestId('onboarding-nav'));
  });

  it('keeps Next in the sticky footer on other steps', async () => {
    mockStep('trust-dial');
    render(<OnboardingPage />);

    const scroll = await screen.findByTestId('onboarding-scroll');
    const nav = await screen.findByTestId('onboarding-nav');
    expect(scroll).not.toContainElement(nav);
  });
});
