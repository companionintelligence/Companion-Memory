import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ItemProperties } from './ItemProperties';

/**
 * Acquired, Made and Expires are days stored as instants (see `lib/thingDate`).
 * Each case runs in a named zone: CI is UTC, where the day before cannot show.
 */
const ZONES = ['America/Los_Angeles', 'UTC', 'Asia/Tokyo'];

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

afterEach(() => {
  // Restore by assignment: deleting TZ leaves Node on the last zone set.
  process.env.TZ = ORIGINAL_TZ ?? SYSTEM_TIME_ZONE;
});

describe.each(ZONES)('ItemProperties dates in %s', (zone) => {
  it('shows a legacy UTC-midnight date as the day it names', () => {
    process.env.TZ = zone;

    render(
      <ItemProperties
        item={{
          acquiredAt: '2024-03-02T00:00:00.000Z',
          manufacturedAt: '2023-11-05T00:00:00.000Z',
          expiresAt: '2027-01-31T00:00:00.000Z',
        }}
      />,
    );

    expect(screen.getByText('Acquired').nextSibling).toHaveTextContent(
      new Date(2024, 2, 2).toLocaleDateString(),
    );
    expect(screen.getByText('Made').nextSibling).toHaveTextContent(
      new Date(2023, 10, 5).toLocaleDateString(),
    );
    expect(screen.getByText('Expires').nextSibling).toHaveTextContent(
      new Date(2027, 0, 31).toLocaleDateString(),
    );
  });

  it('shows the start of a local day, as the form now writes it, as that day', () => {
    process.env.TZ = zone;

    render(
      <ItemProperties
        item={{
          acquiredAt: new Date(2024, 2, 2).toISOString(),
          manufacturedAt: new Date(2023, 10, 5).toISOString(),
          expiresAt: new Date(2027, 0, 31).toISOString(),
        }}
      />,
    );

    expect(screen.getByText('Acquired').nextSibling).toHaveTextContent(
      new Date(2024, 2, 2).toLocaleDateString(),
    );
    expect(screen.getByText('Made').nextSibling).toHaveTextContent(
      new Date(2023, 10, 5).toLocaleDateString(),
    );
    expect(screen.getByText('Expires').nextSibling).toHaveTextContent(
      new Date(2027, 0, 31).toLocaleDateString(),
    );
  });
});
