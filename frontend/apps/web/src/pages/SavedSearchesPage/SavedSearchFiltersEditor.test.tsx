import { useState } from 'react';

import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import type { EditableFilters } from './savedSearchFiltersEdit';
import { SavedSearchFiltersEditor } from './SavedSearchFiltersEditor';

const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ ?? SYSTEM_TIME_ZONE;
});

/** The editor is presentational: hold the value the way its host does. */
function Host({ initial = {} }: { initial?: EditableFilters }) {
  const [value, setValue] = useState<EditableFilters>(initial);

  return <SavedSearchFiltersEditor value={value} onChange={setValue} />;
}

/**
 * MEM-08 re-test: the To field showed the UTC date of what it had stored, so an
 * evening-Pacific end time came back a day late. The stored instant is built from the
 * picked day in LOCAL time (end of day for To, start of day for From), so the day
 * shown has to be read back in local time too.
 */
describe('SavedSearchFiltersEditor dates', () => {
  // West of Greenwich the evening is already tomorrow in UTC; east of it the start of a
  // day is still yesterday. UTC is the control, where the two readings agree.
  it.each(['America/Los_Angeles', 'Asia/Tokyo', 'UTC'])(
    'shows the day that was picked, for From and To, in %s',
    (zone) => {
      process.env.TZ = zone;
      renderWithProviders(<Host />);

      fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-30' } });
      fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } });

      expect(screen.getByLabelText('From')).toHaveValue('2026-09-30');
      expect(screen.getByLabelText('To')).toHaveValue('2026-09-30');
    },
  );

  it('shows a saved evening end time on the day it was picked for, not the next UTC day', () => {
    process.env.TZ = 'America/Los_Angeles';

    // 11:59 PM Pacific on Sep 30 — what To stores for a picked Sep 30.
    renderWithProviders(<Host initial={{ endTime: '2026-10-01T06:59:59.999Z' }} />);

    expect(screen.getByLabelText('To')).toHaveValue('2026-09-30');
  });
});
