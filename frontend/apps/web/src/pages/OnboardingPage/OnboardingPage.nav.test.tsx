import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { OnboardingStepKey } from './constants';
import { OnboardingNav } from './OnboardingNav';
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
  // Back/Skip/Next are ALWAYS pinned below the scroller — a step tall enough
  // to scroll must not push them below the fold. The source steps used to
  // append the nav to the scrolling content; that was reverted deliberately.
  it('keeps Next in the pinned footer on connect-source', async () => {
    mockStep('connect-source');
    render(<OnboardingPage />);

    expect(await screen.findByTestId('connect-source-body')).toBeInTheDocument();
    const scroll = screen.getByTestId('onboarding-scroll');
    expect(scroll).not.toContainElement(screen.getByTestId('onboarding-nav'));
  });

  it('keeps Next in the pinned footer on import-archives', async () => {
    mockStep('import-archives');
    render(<OnboardingPage />);

    expect(await screen.findByTestId('import-archives-body')).toBeInTheDocument();
    const scroll = screen.getByTestId('onboarding-scroll');
    expect(scroll).not.toContainElement(screen.getByTestId('onboarding-nav'));
  });

  it('keeps Next in the pinned footer on other steps', async () => {
    mockStep('trust-dial');
    render(<OnboardingPage />);

    const scroll = await screen.findByTestId('onboarding-scroll');
    const nav = await screen.findByTestId('onboarding-nav');
    expect(scroll).not.toContainElement(nav);
  });
});

describe('Onboarding step caption', () => {
  it('keeps the caption line on later steps so the buttons do not drop', async () => {
    mockStep('intro');
    const firstView = render(<OnboardingPage />);

    const first = await screen.findByTestId('onboarding-step-caption');

    expect(first).toHaveTextContent('every step is skippable');
    expect(first.className).toContain('min-h-4');

    firstView.unmount();
    mockStep('time-and-place');
    render(<OnboardingPage />);

    const later = await screen.findByTestId('onboarding-step-caption');

    expect(later).not.toHaveTextContent('skippable');
    expect(later.className).toContain('min-h-4');
  });
});

describe('OnboardingNav primary width', () => {
  it('keeps Next the same width whether or not Back is in the row', () => {
    const { rerender } = render(
      <OnboardingNav canGoBack={false} onBack={() => {}} onSkip={() => {}} onNext={() => {}} />,
    );

    const withoutBack = screen.getByRole('button', { name: 'Next' });

    expect(withoutBack.className).toContain('w-44');
    expect(withoutBack.className).not.toContain('flex-1');

    rerender(<OnboardingNav canGoBack onBack={() => {}} onSkip={() => {}} onNext={() => {}} />);

    expect(screen.getByRole('button', { name: 'Next' }).className).toContain('w-44');
  });
});
