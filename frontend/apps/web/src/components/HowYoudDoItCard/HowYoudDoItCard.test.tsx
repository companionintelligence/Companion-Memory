import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { HowYoudDoItResult } from '@/api/usePersonaCompose';

import { HowYoudDoItCard } from './HowYoudDoItCard';

function result(overrides: Partial<HowYoudDoItResult> = {}): HowYoudDoItResult {
  return {
    task: { title: 'Plan a calm dinner', goal: 'Four friends, Friday', openQuestions: [], constraints: [] },
    personaBrief: 'You cook ahead and keep the guest list small.',
    approach: [
      { title: 'Pick the menu', detail: 'Two courses you have made before', durationMinutes: 15 },
      { title: 'Shop Thursday' },
    ],
    timing: 'Friday evening',
    people: ['Sam', 'Alex'],
    evidence: [{ kind: 'dossier', id: 'd1', note: 'Prefers small gatherings' }],
    followUps: ['Who else is coming?'],
    confidence: 0.82,
    hasSignal: true,
    ...overrides,
  };
}

describe('HowYoudDoItCard', () => {
  it('renders the task, brief, numbered approach and confidence', () => {
    render(<HowYoudDoItCard result={result()} />);

    expect(screen.getByText('Plan a calm dinner')).toBeInTheDocument();
    expect(screen.getByText('Four friends, Friday')).toBeInTheDocument();
    expect(screen.getByText('You cook ahead and keep the guest list small.')).toBeInTheDocument();
    expect(screen.getByText('Pick the menu')).toBeInTheDocument();
    expect(screen.getByText('Two courses you have made before')).toBeInTheDocument();
    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();
    expect(screen.getByText('Timing: Friday evening')).toBeInTheDocument();
    expect(screen.getByText('People: Sam, Alex')).toBeInTheDocument();
    expect(screen.getByText('Prefers small gatherings')).toBeInTheDocument();
  });

  it('explains a thin result instead of rendering an empty list', () => {
    render(<HowYoudDoItCard result={result({ approach: [] })} />);

    expect(screen.getByText(/Not enough signal to personalize confidently yet/)).toBeInTheDocument();
  });

  it('makes follow-ups clickable when a handler is given', () => {
    const onFollowUp = vi.fn();
    render(<HowYoudDoItCard result={result()} onFollowUp={onFollowUp} />);

    fireEvent.click(screen.getByRole('button', { name: 'Who else is coming?' }));
    expect(onFollowUp).toHaveBeenCalledWith('Who else is coming?');
  });

  it('renders follow-ups as plain text rather than dead buttons without a handler', () => {
    render(<HowYoudDoItCard result={result()} />);

    expect(screen.getByText('Who else is coming?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Who else is coming?' })).not.toBeInTheDocument();
  });

  it('offers Add to Possibilities only when there is an approach to add', () => {
    const onApply = vi.fn();
    const { rerender } = render(<HowYoudDoItCard result={result()} onApply={onApply} />);

    fireEvent.click(screen.getByRole('button', { name: /Add to Possibilities/ }));
    expect(onApply).toHaveBeenCalled();

    rerender(<HowYoudDoItCard result={result({ approach: [] })} onApply={onApply} />);
    expect(screen.queryByRole('button', { name: /Add to Possibilities/ })).not.toBeInTheDocument();
  });

  it('surfaces the apply note and disables the button while applying', () => {
    render(
      <HowYoudDoItCard
        result={result()}
        applying
        applyNote="Added 2 cards to Possibilities."
        onApply={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Add to Possibilities/ })).toBeDisabled();
    expect(screen.getByText('Added 2 cards to Possibilities.')).toBeInTheDocument();
  });

  it('does not link back to About you — it now renders inside it', () => {
    render(<HowYoudDoItCard result={result()} />);

    expect(screen.queryByText(/This isn’t me/)).not.toBeInTheDocument();
  });
});
