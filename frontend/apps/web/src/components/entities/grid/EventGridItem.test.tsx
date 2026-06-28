import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';

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
    render(<EventGridItem event={makeEvent()} />);

    expect(screen.getByText('Team offsite')).toBeInTheDocument();
    expect(screen.getByText('Quarterly planning')).toBeInTheDocument();
    expect(screen.getByText('Long Beach')).toBeInTheDocument();
  });

  it('falls back to "Untitled event" with no title', () => {
    render(<EventGridItem event={makeEvent({ title: null })} />);

    expect(screen.getByText('Untitled event')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    render(<EventGridItem event={makeEvent()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Team offsite'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
