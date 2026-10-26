import { useState } from 'react';

import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { toFiltersInput, type EditableFilters } from './savedSearchFiltersEdit';
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

describe('SavedSearchFiltersEditor rolling When', () => {
  it('says a rolling preset is stored, and a picked date replaces it instead of being ignored', () => {
    const onChange = vi.fn();

    function Spy({ initial }: { initial: EditableFilters }) {
      const [value, setValue] = useState<EditableFilters>(initial);

      return (
        <SavedSearchFiltersEditor
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    renderWithProviders(<Spy initial={{ datePreset: 'last-month' }} />);

    expect(screen.getByTestId('filters-rolling-when')).toHaveTextContent('When: Last month');

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-23' } });

    const saved = toFiltersInput(onChange.mock.calls.at(-1)?.[0] as EditableFilters);

    expect(saved?.datePreset).toBeUndefined();
    expect(saved?.startTime).toBeDefined();
    expect(saved?.endTime).toBeDefined();
    expect(screen.queryByTestId('filters-rolling-when')).not.toBeInTheDocument();
  });

  it('removes the rolling preset on its own', () => {
    renderWithProviders(<Host initial={{ datePreset: 'last-week', people: ['Jane Smith'] }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.queryByTestId('filters-rolling-when')).not.toBeInTheDocument();
  });
});
