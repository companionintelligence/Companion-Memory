import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DisclosureHistory, type DisclosureRow } from './DisclosureHistory';

const BIDI_OR_INVISIBLE = /[‪-‮⁦-⁩‎‏؜​]/u;
const CURLY_QUOTE = /[“”]/u;

/**
 * A data class from a linked peer that closes a quotation, speaks in the app's
 * voice, and carries a right-to-left override to reorder what follows it.
 */
const HOSTILE_CLASS = 'photos” · nothing was shared ‮detareneg-otua‬ “';

function row(overrides: Partial<DisclosureRow> = {}): DisclosureRow {
  return {
    id: 'audit-1',
    askerName: 'Ana',
    askerAvatarUrl: null,
    outcome: 'auto_answered',
    disclosedCount: 3,
    consentBasis: 'grant-1',
    createdAt: '2026-11-01T10:00:00.000Z',
    query: { queryType: 'content', dataClass: HOSTILE_CLASS, prompt: 'Lake photos?' },
    ...overrides,
  };
}

/** The text of `element` with every peer-supplied element left out. */
function appTextOf(element: Element): string {
  const copy = element.cloneNode(true) as Element;

  copy.querySelectorAll('[data-peer-text], blockquote').forEach((node) => node.remove());

  return copy.textContent ?? '';
}

describe('DisclosureHistory — the peer’s scope cannot rewrite the record', () => {
  it('shows the data class as attributed text and keeps the magnitude its own sentence', () => {
    // Plain `render`: the list needs no providers (the date format falls back
    // to its context default), so Apollo stays out of this suite.
    const { container } = render(<DisclosureHistory rows={[row()]} />);

    const label = screen.getByText('Data class they named:');
    const peer = label.parentElement?.querySelector<HTMLElement>('[data-peer-text]');

    expect(peer).not.toBeNull();
    expect(peer?.textContent).toContain('photos” · nothing was shared');
    expect(peer?.textContent).not.toMatch(BIDI_OR_INVISIBLE);
    expect(peer).toHaveAttribute('dir', 'ltr');
    expect(peer?.style.unicodeBidi).toBe('isolate');

    // The decision-relevant facts are still there, in the app's own words.
    expect(screen.getByText('Result: 3 items shared.')).toBeInTheDocument();
    expect(screen.getByText('Asked about:').parentElement).toHaveTextContent('Asked about: content');

    // Nothing the peer wrote reaches the app's copy, and no quote mark or bidi
    // control sits outside their element.
    const appText = appTextOf(container);

    expect(appText).not.toContain('nothing was shared');
    expect(appText).not.toContain('photos');
    expect(appText.replace(/“Who can ask me what”/u, '')).not.toMatch(CURLY_QUOTE);
    expect(container.textContent ?? '').not.toMatch(BIDI_OR_INVISIBLE);
  });

  it('omits the data-class line when the ask named none', () => {
    render(
      <DisclosureHistory rows={[row({ query: { queryType: 'relationship', prompt: 'Know Carol?' } })]} />,
    );

    expect(screen.queryByText('Data class they named:')).toBeNull();
    expect(screen.getByText('Asked about:').parentElement).toHaveTextContent('Asked about: relationship');
  });
});
