import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AboutYouView, HowYoudDoItResult } from '@/api/usePersonaCompose';

import { AboutYouSection } from './AboutYouSection';

const view: AboutYouView = {
  name: 'Bennett',
  dossier: { summary: 'Cooks ahead, keeps guest lists small.', tone: 'warm', personalityTraits: ['calm'] },
  preferences: [
    { entityId: 'p1', name: 'Mornings', type: 'time', category: null, strength: 1, relationship: 'PREFERS' },
    {
      entityId: 'p2',
      name: 'Evening calls',
      type: 'time',
      category: null,
      strength: 1,
      relationship: 'DISLIKES',
    },
  ],
  family: [],
  recentAnswers: [],
  schedule: null,
  trustMode: 'balanced',
  hasSignal: true,
};

const composed: HowYoudDoItResult = {
  task: { title: 'Plan a calm dinner', openQuestions: [], constraints: [] },
  personaBrief: 'You cook ahead.',
  approach: [{ title: 'Pick the menu' }],
  people: [],
  evidence: [],
  followUps: ['Who else is coming?'],
  confidence: 0.8,
  hasSignal: true,
};

const h = vi.hoisted(() => ({
  fetchAboutYou: vi.fn(),
  submitAboutYouCorrection: vi.fn(),
  compose: vi.fn(),
  apply: vi.fn(),
  clear: vi.fn(),
  result: null as unknown,
  loading: false,
  error: null as string | null,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'token', authenticated: true }, {}],
}));

vi.mock('@/api/usePersonaCompose', () => ({
  fetchAboutYou: h.fetchAboutYou,
  submitAboutYouCorrection: h.submitAboutYouCorrection,
  usePersonaCompose: () => [
    { loading: h.loading, error: h.error, result: h.result },
    { compose: h.compose, apply: h.apply, clear: h.clear, setResult: vi.fn() },
  ],
}));

beforeEach(() => {
  h.fetchAboutYou.mockReset().mockResolvedValue(view);
  h.submitAboutYouCorrection.mockReset().mockResolvedValue({ questionId: 'q1', answerId: 'a1' });
  h.compose.mockReset().mockResolvedValue(composed);
  h.apply.mockReset().mockResolvedValue({ added: 2 });
  h.clear.mockReset();
  h.result = null;
  h.loading = false;
  h.error = null;
});

async function renderSection() {
  render(<AboutYouSection />);
  await waitFor(() => expect(screen.getByText('About you')).toBeInTheDocument());
}

describe('AboutYouSection', () => {
  it('renders what Companion knows — dossier, preferences, dislikes, autonomy', async () => {
    await renderSection();

    expect(screen.getByText('Cooks ahead, keeps guest lists small.')).toBeInTheDocument();
    expect(screen.getByText('Mornings')).toBeInTheDocument();
    expect(screen.getByText('Evening calls')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
  });

  it('composes a personalized approach from a task', async () => {
    await renderSection();

    fireEvent.change(screen.getByLabelText('Task to personalize'), {
      target: { value: 'Plan a calm dinner' },
    });
    fireEvent.click(screen.getByRole('button', { name: /How I’d do this/ }));

    await waitFor(() => expect(h.compose).toHaveBeenCalledWith('Plan a calm dinner'));
  });

  it('will not compose an empty task', async () => {
    await renderSection();

    expect(screen.getByRole('button', { name: /How I’d do this/ })).toBeDisabled();
    expect(h.compose).not.toHaveBeenCalled();
  });

  it('renders the result card and adds it to Possibilities', async () => {
    h.result = composed;
    await renderSection();

    expect(screen.getByText('Plan a calm dinner')).toBeInTheDocument();
    expect(screen.getByText('Pick the menu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add to Possibilities/ }));
    await waitFor(() => expect(screen.getByText('Added 2 cards to Possibilities.')).toBeInTheDocument());
  });

  it('routes a follow-up into the correction box instead of a second write path', async () => {
    h.result = composed;
    await renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Who else is coming?' }));

    expect(screen.getByText('Answering: Who else is coming?')).toBeInTheDocument();

    const box = screen.getByPlaceholderText(/I prefer short meetings/);
    fireEvent.change(box, { target: { value: 'Sam and Alex.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => expect(h.submitAboutYouCorrection).toHaveBeenCalledWith('token', 'Sam and Alex.'));
    await waitFor(() => expect(screen.queryByText(/^Answering:/)).not.toBeInTheDocument());
  });

  it('saves a standalone correction and reloads the profile', async () => {
    await renderSection();

    fireEvent.change(screen.getByPlaceholderText(/I prefer short meetings/), {
      target: { value: 'I hate evening calls.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() =>
      expect(h.submitAboutYouCorrection).toHaveBeenCalledWith('token', 'I hate evening calls.'),
    );
    await waitFor(() => expect(screen.getByText(/Saved — the next/)).toBeInTheDocument());
    expect(h.fetchAboutYou).toHaveBeenCalledTimes(2);
  });

  it('surfaces a compose failure without wiping the page', async () => {
    h.error = 'Could not personalize that task.';
    await renderSection();

    expect(screen.getByText('Could not personalize that task.')).toBeInTheDocument();
    expect(screen.getByText('Cooks ahead, keeps guest lists small.')).toBeInTheDocument();
  });

  it('offers a retry when the profile itself fails to load', async () => {
    h.fetchAboutYou.mockRejectedValueOnce(new Error('nope'));
    render(<AboutYouSection />);

    await waitFor(() =>
      expect(screen.getByText('Could not load what Companion knows about you.')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('About you')).toBeInTheDocument());
  });
});
