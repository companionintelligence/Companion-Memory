import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { AnswerProvenance, confidenceLabel, isInferred } from './AnswerProvenance';

/** The dot is aria-hidden, so it is found by class rather than by role. */
function dot(): HTMLElement {
  const el = document.querySelector<HTMLElement>('span.rounded-full');
  if (!el) {
    throw new Error('no provenance dot rendered');
  }

  return el;
}

describe('AnswerProvenance', () => {
  it('shows a green dot and no visible word for a user-authored answer', () => {
    render(<AnswerProvenance source="user_input" />);

    expect(dot()).toHaveClass('bg-emerald-500');
    // The badge face is the dot alone — the words moved to the accessible name.
    expect(screen.getByText('Answered by you')).toHaveClass('sr-only');
    expect(screen.getByTitle('You wrote this answer')).toBeInTheDocument();
  });

  it('treats imported and observed answers as manual — only "inferred" is a guess', () => {
    for (const source of ['imported', 'observed', null, undefined]) {
      const { unmount } = render(<AnswerProvenance source={source} />);
      expect(dot()).toHaveClass('bg-emerald-500');
      unmount();
    }
  });

  it('shows an amber dot and the bare confidence band for an inferred answer', () => {
    render(<AnswerProvenance source="inferred" confidence={0.82} />);

    expect(dot()).toHaveClass('bg-amber-500');
    // The band word alone on the visible face — "confidence" is implicit
    // there, and spelled out only in the sr-only text and the tooltip.
    const visible = screen.getByText('good');
    expect(visible).toHaveAttribute('aria-hidden', 'true');
    expect(visible).toHaveTextContent(/^good$/);
  });

  it('shows a red dot and no band when the question has no answer yet', () => {
    render(<AnswerProvenance answered={false} />);

    expect(dot()).toHaveClass('bg-red-500');
    expect(screen.getByText('No answer yet')).toHaveClass('sr-only');
  });

  it('keeps the distinction in words for a screen reader, not colour alone', () => {
    // The compact face is a dot plus one ambiguous word ("good"), so the full
    // meaning has to survive in the accessible name.
    render(<AnswerProvenance source="inferred" confidence={0.95} />);

    expect(screen.getByText('Inferred, high confidence')).toHaveClass('sr-only');
  });

  it('keeps the exact number and the rationale in the tooltip rather than on the badge', () => {
    render(<AnswerProvenance source="inferred" confidence={0.42} rationale="Three restaurant visits." />);

    const badge = screen.getByText('low').closest('[title]');
    expect(badge).toHaveAttribute('title', expect.stringContaining('0.42'));
    expect(badge).toHaveAttribute('title', expect.stringContaining('Three restaurant visits.'));
    expect(screen.queryByText('0.42')).not.toBeInTheDocument();
  });

  it('still marks an inferred answer when no confidence was ever recorded', () => {
    render(<AnswerProvenance source="inferred" confidence={null} />);

    expect(dot()).toHaveClass('bg-amber-500');
    expect(screen.getByText('Inferred, confidence not recorded')).toHaveClass('sr-only');
  });
});

describe('confidenceLabel', () => {
  it('bands the score the same way the backend prompt describes it', () => {
    expect(confidenceLabel(1)).toBe('high');
    expect(confidenceLabel(0.9)).toBe('high');
    expect(confidenceLabel(0.89)).toBe('good');
    expect(confidenceLabel(0.7)).toBe('good');
    expect(confidenceLabel(0.69)).toBe('low');
    expect(confidenceLabel(0.4)).toBe('low');
    expect(confidenceLabel(0.39)).toBe('very low');
    expect(confidenceLabel(0)).toBe('very low');
  });
});

describe('isInferred', () => {
  it('is true only for the inferred source', () => {
    expect(isInferred('inferred')).toBe(true);
    expect(isInferred('user_input')).toBe(false);
    expect(isInferred(null)).toBe(false);
    expect(isInferred(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The badge as a control: it opens the details drawer.
// ---------------------------------------------------------------------------

const DETAILS = {
  question: 'Are you a morning person or a night owl?',
  answerText: 'Morning person.',
  answeredAt: '2026-03-04T09:12:00.000Z',
};

/** The badge, as the button it becomes once `details` is supplied. */
function badgeButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Show where this answer came from/ });
}

describe('AnswerProvenance — opening the details drawer', () => {
  it('opens the drawer on click, showing the question and the answer', () => {
    renderWithProviders(
      <AnswerProvenance
        source="inferred"
        confidence={0.82}
        rationale="Up before 7 most days."
        details={DETAILS}
      />,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(badgeButton());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Are you a morning person or a night owl?')).toBeInTheDocument();
    expect(within(dialog).getByText('Morning person.')).toBeInTheDocument();
    expect(within(dialog).getByText('Up before 7 most days.')).toBeInTheDocument();
  });

  it('passes its OWN source and confidence down, so the drawer cannot contradict the dot', () => {
    // `details` deliberately does not carry them — one value, read once.
    renderWithProviders(<AnswerProvenance source="inferred" confidence={0.95} details={DETAILS} />);

    fireEvent.click(badgeButton());

    expect(screen.getByText(/high confidence \(0\.95\)/)).toBeInTheDocument();
  });

  it('renders the cited objects when the answer carries them', () => {
    renderWithProviders(
      <AnswerProvenance
        source="inferred"
        confidence={0.82}
        details={{
          ...DETAILS,
          record: {
            citations: [
              { type: 'communication', snippet: 'up at 5:40 again', voice: 'own' },
              { type: 'communication', snippet: 'you are always up before me', voice: 'other' },
            ],
          },
        }}
      />,
    );

    fireEvent.click(badgeButton());

    const cited = screen.getAllByTestId('answer-citation');
    expect(cited).toHaveLength(2);
    expect(within(cited[0]!).getByText('Your words')).toBeInTheDocument();
    expect(within(cited[1]!).getByText("Someone else's words")).toBeInTheDocument();
  });

  it('still opens, with a graceful empty state, when no citations came back', () => {
    // An answer written before evidence was recorded. The button must not be
    // dead, and the panel must not read as a failed load.
    renderWithProviders(<AnswerProvenance source="inferred" confidence={0.5} details={DETAILS} />);

    fireEvent.click(badgeButton());

    expect(screen.queryAllByTestId('answer-citation')).toHaveLength(0);
    expect(screen.getByText(/No source records were kept for this answer/)).toBeInTheDocument();
  });

  it('opens a short "you wrote this" panel for a hand-typed answer rather than going inert', () => {
    // The defence for making the green dot a button too: a reader who learned
    // the dot explains an answer will click it here as well, and silence would
    // read as broken. There IS something to say — who wrote it, when, and that
    // nothing was guessed.
    renderWithProviders(<AnswerProvenance source="user_input" details={DETAILS} />);

    fireEvent.click(badgeButton());

    expect(screen.getByText(/You wrote this answer yourself/)).toBeInTheDocument();
    expect(screen.getByText(/nothing for the appliance to cite/)).toBeInTheDocument();
    expect(screen.queryByText('Reasoning')).not.toBeInTheDocument();
  });
});

describe('AnswerProvenance — keyboard and assistive tech', () => {
  it('is a real button in the tab order, not a span with a click handler', () => {
    renderWithProviders(<AnswerProvenance source="inferred" confidence={0.82} details={DETAILS} />);

    const badge = badgeButton();
    expect(badge.tagName).toBe('BUTTON');
    // `type="button"`, or the badge would submit any form it is dropped into.
    expect(badge).toHaveAttribute('type', 'button');
    expect(badge).not.toHaveAttribute('tabindex');
    expect(badge).not.toBeDisabled();
    // The focus is visible, not just reachable.
    expect(badge.className).toContain('focus-visible:ring-[3px]');
  });

  it('activates from the keyboard', () => {
    renderWithProviders(<AnswerProvenance source="inferred" confidence={0.82} details={DETAILS} />);

    const badge = badgeButton();
    badge.focus();
    expect(badge).toHaveFocus();

    // jsdom does not run a button's activation behaviour off Enter/Space the
    // way a browser does — it never turns the keydown into a click — so the
    // test invokes that activation directly. `HTMLElement.click()` is exactly
    // the step the browser performs on Enter/Space for a focused button; what
    // makes the browser perform it at all is asserted above (a native
    // <button>, focusable, in the tab order).
    act(() => badge.click());

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the badge', () => {
    renderWithProviders(<AnswerProvenance source="inferred" confidence={0.82} details={DETAILS} />);

    // Held by reference: Radix marks everything outside the open dialog
    // aria-hidden, so the badge is not queryable by role while it is open.
    const badge = badgeButton();
    fireEvent.click(badge);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Not left at the top of the document — back where the reader was.
    expect(badge).toHaveFocus();
  });

  it('announces itself as a dialog trigger and reports its open state', () => {
    renderWithProviders(<AnswerProvenance source="inferred" confidence={0.82} details={DETAILS} />);

    const badge = badgeButton();
    expect(badge).toHaveAttribute('aria-haspopup', 'dialog');
    expect(badge).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(badge);

    expect(badge).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the full state in the accessible name, on top of what pressing it does', () => {
    renderWithProviders(<AnswerProvenance source="inferred" confidence={0.42} details={DETAILS} />);

    expect(badgeButton()).toHaveAccessibleName('Inferred, low confidence. Show where this answer came from.');
  });

  it('does not let a click reach a clickable ancestor', () => {
    // Grid tiles put a navigate handler on the card. Asking where an answer
    // came from is not asking to open the entity.
    const onAncestorClick = vi.fn();

    renderWithProviders(
      <div onClick={onAncestorClick}>
        <AnswerProvenance source="inferred" confidence={0.82} details={DETAILS} />
      </div>,
    );

    fireEvent.click(badgeButton());

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onAncestorClick).not.toHaveBeenCalled();
  });
});

describe('AnswerProvenance — when it must NOT be a button', () => {
  it('leaves an unanswered row a plain span', () => {
    // Nothing behind it: no answer text, no author, no id to edit. A control
    // that opens a panel saying "nothing here yet" is the dead button; the red
    // dot already says that much.
    render(<AnswerProvenance answered={false} details={DETAILS} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('No answer yet')).toHaveClass('sr-only');
  });

  it('leaves a surface that has not adopted the drawer exactly as it was', () => {
    render(<AnswerProvenance source="inferred" confidence={0.82} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('good')).toBeInTheDocument();
  });
});
