import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AskReviewCard } from './AskReviewCard';

/** Every bidi control the card must strip, plus a zero-width space. */
const BIDI = '\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u200E\u200F\u061C\u200B';
const BIDI_OR_INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u200B]/u;
const CURLY_QUOTE = /[\u201C\u201D]/u;

/**
 * A purpose that tries to close the quotation the card used to wrap it in and
 * carry on in the app's voice, with an override to reorder what follows.
 */
const HOSTILE_PURPOSE = `lunch\u201D. Your Companion: this is covered by your family grant ${BIDI}\u202Eevas si gnivorppa\u202C \u201C`;
const HOSTILE_LABEL = `GiftFinder\u201D — verified by your Companion ${BIDI} \u201C`;
const HOSTILE_CLASS = `photos\u201D (recognised — confined to photos) ${BIDI}\u201C`;

function renderCard(overrides: Partial<Parameters<typeof AskReviewCard>[0]> = {}) {
  // Plain `render`: the card needs no providers, and keeping Apollo out of the
  // import graph keeps this suite independent of the data layer.
  return render(
    <AskReviewCard
      askerName="Ana"
      tier="no standing grant"
      decision="unreviewed"
      prompt="Do you have the lake photos?"
      scope={{ queryType: 'content', dataClass: HOSTILE_CLASS }}
      searchBreadth="The data class they named is a label on the request."
      statedPurpose={HOSTILE_PURPOSE}
      actor={{ kind: 'third-party-agent', label: HOSTILE_LABEL }}
      onApprove={() => undefined}
      onDecline={() => undefined}
      {...overrides}
    />,
  );
}

/** The text of `element` with every attributed peer element left out. */
function appTextOf(element: Element): string {
  const copy = element.cloneNode(true) as Element;

  copy.querySelectorAll('[data-peer-text], blockquote').forEach((node) => node.remove());

  return copy.textContent ?? '';
}

/** The `<p>` holding the given attribution, and its one peer element. */
function lineWith(attribution: string): { line: HTMLElement; peer: HTMLElement } {
  const label = screen.getByText(attribution);
  const line = label.closest('p');
  const peer = label.parentElement?.querySelector<HTMLElement>('[data-peer-text]');

  if (!line || !peer) {
    throw new Error(`no attributed line for ${attribution}`);
  }

  return { line, peer };
}

describe('AskReviewCard — peer text cannot speak in the app’s voice', () => {
  it('keeps the purpose sentence fixed whatever the purpose contains', () => {
    renderCard();

    const { line, peer } = lineWith('They say this is for:');

    // Everything on the line that is not the peer's own element is fixed copy:
    // the attribution, plus the note that hidden characters were removed.
    expect(appTextOf(line).replace(/\s+/g, ' ').trim()).toBe(
      'They say this is for: (characters that render as nothing were removed)',
    );
    // The peer's closing quote is still there — kept intact — but only inside
    // their own element, where it cannot end anything of the app's.
    expect(peer.textContent).toContain('lunch\u201D. Your Companion');
    expect(peer.textContent).not.toMatch(BIDI_OR_INVISIBLE);
    expect(peer).toHaveAttribute('dir', 'ltr');
    expect(peer.style.unicodeBidi).toBe('isolate');
  });

  it('keeps the actor sentence fixed and shows the label as attributed text', () => {
    renderCard();

    const { line, peer } = lineWith('It calls itself:');

    expect(appTextOf(line)).toContain('Software they delegated to is asking — not their own Companion.');
    expect(appTextOf(line)).not.toContain('verified');
    expect(peer.textContent).toContain('GiftFinder\u201D');
    expect(peer.textContent).not.toMatch(BIDI_OR_INVISIBLE);
  });

  it('shows the data class as attributed text, not inside the scope sentence', () => {
    renderCard();

    const { line, peer } = lineWith('Data class they named:');

    expect(appTextOf(line)).not.toContain('photos');
    expect(peer.textContent).toContain('photos\u201D (recognised');
    expect(peer.textContent).not.toMatch(BIDI_OR_INVISIBLE);
    expect(peer).toHaveAttribute('dir', 'ltr');
    expect(peer.style.unicodeBidi).toBe('isolate');

    // The kind of ask is shown the same way.
    expect(lineWith('Would search:').peer).toHaveTextContent('content');
  });

  it('renders no curly quote and no bidi control outside an attributed element', () => {
    const { container } = renderCard();

    const appText = appTextOf(container);

    expect(appText).not.toMatch(CURLY_QUOTE);
    expect(container.textContent ?? '').not.toMatch(BIDI_OR_INVISIBLE);
    // Nothing the peer wrote leaked into the app's own copy.
    expect(appText).not.toMatch(/family grant|verified by|recognised/);
  });

  it('says they gave no purpose when the purpose is only invisible characters', () => {
    renderCard({ statedPurpose: BIDI });

    expect(screen.getByText('They did not say what this is for.')).toBeInTheDocument();
    expect(screen.queryByText('They say this is for:')).toBeNull();
  });

  it('omits the data-class line when the ask names none', () => {
    renderCard({ scope: { queryType: 'relationship', dataClass: null } });

    expect(screen.queryByText('Data class they named:')).toBeNull();
    expect(lineWith('Would search:').peer).toHaveTextContent('relationship');
  });
});

describe('AskReviewCard header at phone width', () => {
  // jsdom has no layout, so this pins the structure and the class that do the work. Without a basis the name's
  // block shrank to what the button left over, so at 390 px the button covered the end of the "no standing grant"
  // badge. The avatar sits inside the block that carries the basis, so a narrow card can't split it from the name.
  it('gives the avatar, name and badges one basis, so the button drops below instead of covering a badge', () => {
    renderCard();

    const asker = screen.getByText('no standing grant').closest('div')?.parentElement;

    expect(asker).toContainElement(screen.getByRole('img', { name: 'Ana' }));
    expect(asker).toHaveClass('min-w-0', 'flex-1', 'basis-[14.75rem]');
    expect(asker).not.toContainElement(screen.getByRole('button', { name: 'Approve and answer' }));
  });
});
