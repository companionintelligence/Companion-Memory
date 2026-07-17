import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { EVENT_FRAGMENT, EventGridItem } from './EventGridItem';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return makeFragmentData(
    {
      __typename: 'EventType' as const,
      id: 'e1',
      title: 'Team offsite',
      description: 'Quarterly planning',
      startTime: '2026-01-15T17:00:00Z',
      eventType: 'meeting',
      locationName: 'Long Beach',
      sourceSystem: null,
      ...overrides,
    },
    EVENT_FRAGMENT,
  );
}

describe('EventGridItem', () => {
  it('renders the title, description and location', () => {
    renderWithProviders(<EventGridItem event={makeEvent()} />);

    expect(screen.getByText('Team offsite')).toBeInTheDocument();
    expect(screen.getByText('Quarterly planning')).toBeInTheDocument();
    expect(screen.getByText('Long Beach')).toBeInTheDocument();
  });

  it('renders a non-empty fallback title when the event has no title', () => {
    // The exact fallback varies by environment — a bare "Untitled event" or a
    // computed "Photo · place · date" display title (PR #1569 media events) —
    // so assert the title slot is simply non-empty rather than pinning a string.
    const { container } = renderWithProviders(<EventGridItem event={makeEvent({ title: null })} />);
    const titleEl = container.querySelector('.text-md.font-semibold.truncate');

    expect((titleEl?.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<EventGridItem event={makeEvent()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Team offsite'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
