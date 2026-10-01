import { InMemoryCache } from '@apollo/client';
import { MockedProvider, type MockedResponse } from '@apollo/client/testing';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  UpdateCurrentUserTimeFormatDocument as UPDATE_TIME_FORMAT,
  UpdateCurrentUserTimezoneDocument as UPDATE_TIMEZONE,
} from '@/graphql/graphql';
import { DateTimeFormatOverride } from '@/hooks/useDateTimeFormat';
import { createDateTimeFormatter, type TimeFormat } from '@/lib/dateTimeFormat';
import { detectBrowserTimeZone } from '@/lib/timezone';

import { PreferencesSection } from './PreferencesSection';

/**
 * Settings › Preferences › Time format.
 *
 * Worth pinning: the control shows the saved choice, previews each option on the person's own
 * clock before anything is saved, and a save sends only what changed — the time format through
 * its own document, so a timezone save never selects a field an older server does not have.
 */

const h = vi.hoisted(() => ({
  user: { id: 'u1', timezone: 'Asia/Tokyo' },
}));

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: h.user, loading: false, error: undefined, refetch: vi.fn() }),
}));

/** 15:43 in Los Angeles — an afternoon, so 12- and 24-hour differ in more than a leading zero. */
const NOW = new Date('2026-09-30T22:43:00Z');

function savesTimeFormat(timeFormat: TimeFormat): MockedResponse {
  return {
    request: { query: UPDATE_TIME_FORMAT, variables: { input: { timeFormat } } },
    result: { data: { updateCurrentUser: { __typename: 'UserType', id: 'u1', timeFormat } } },
  };
}

function renderSection({
  saved = 'auto',
  mocks = [],
}: { saved?: TimeFormat; mocks?: MockedResponse[] } = {}) {
  return render(
    <MockedProvider mocks={mocks} cache={new InMemoryCache()}>
      <DateTimeFormatOverride
        formatter={createDateTimeFormatter({ timeFormat: saved, timeZone: 'America/Los_Angeles' })}
      >
        <PreferencesSection />
      </DateTimeFormatOverride>
    </MockedProvider>,
  );
}

function choose(label: string) {
  fireEvent.click(screen.getByLabelText('Time format'));
  fireEvent.click(screen.getByRole('option', { name: label }));
}

const example = () => screen.getByTestId('time-format-example');

beforeEach(() => {
  h.user = { id: 'u1', timezone: 'Asia/Tokyo' };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PreferencesSection — time format', () => {
  it('offers Automatic, 12-hour and 24-hour, showing the saved choice', () => {
    renderSection({ saved: 'h23' });

    const trigger = screen.getByLabelText('Time format');
    expect(within(trigger).getByText('24-hour')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Automatic (from this device)',
      '12-hour',
      '24-hour',
    ]);
  });

  it('previews each option on the person’s own clock before anything is saved', () => {
    renderSection();

    // 'auto' in a 12-hour test locale; the clock is the profile's (Los Angeles), not the runner's.
    expect(example()).toHaveTextContent(/Times will look like 3:43\sPM/);

    choose('24-hour');
    expect(example()).toHaveTextContent('Times will look like 15:43');

    choose('12-hour');
    expect(example()).toHaveTextContent(/Times will look like 3:43\sPM/);
  });

  it('keeps Save off until the choice differs from the saved one', () => {
    renderSection({ saved: 'h12' });

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    choose('24-hour');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    choose('12-hour');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves only the time format, through its own mutation', async () => {
    // No timezone mock: a timezone write here would fail the save and show its error.
    renderSection({ mocks: [savesTimeFormat('h23')] });

    choose('24-hour');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.queryByText(/Failed to save/)).not.toBeInTheDocument();
  });

  it('saves a timezone change without touching the time format', async () => {
    const detected = detectBrowserTimeZone();
    // Any saved zone the runner is not in, so "use the detected one" is a real change.
    h.user = { id: 'u1', timezone: detected === 'Asia/Tokyo' ? 'Europe/Paris' : 'Asia/Tokyo' };

    renderSection({
      mocks: [
        {
          request: { query: UPDATE_TIMEZONE, variables: { input: { timezone: detected } } },
          result: { data: { updateCurrentUser: { __typename: 'UserType', id: 'u1', timezone: detected } } },
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: /\(GMT|UTC/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('says so when the time format cannot be saved', async () => {
    renderSection({
      mocks: [
        {
          request: { query: UPDATE_TIME_FORMAT, variables: { input: { timeFormat: 'h12' } } },
          result: { errors: [new GraphQLError('Unknown argument "timeFormat"')] },
        },
      ],
    });

    choose('12-hour');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Failed to save time format. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
