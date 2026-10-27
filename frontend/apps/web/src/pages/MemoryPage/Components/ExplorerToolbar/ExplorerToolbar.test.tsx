import { Children, isValidElement, type ReactNode } from 'react';

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useSearchParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SearchBox } from '@/components/SearchBox/SearchBox';
import { DropdownProvider } from '@/components/SearchBox/useDropdown';
import { PERSON_NAME_SUGGESTIONS_QUERY } from '@/components/SearchBox/useNameSuggestions';
import { gql } from '@/graphql';
import { GetSavedSearchDocument, GetSavedSearchesForPickerDocument } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders, type RenderWithProvidersOptions } from '@/test/renderWithProviders';

import { UPDATE_SAVED_SEARCH } from '../../../SavedSearchesPage/EditSavedSearchModal';

import {
  AdvancedFilters,
  ExplorerToolbar,
  MemoryExplorerFilterControls,
  SearchPanelFilters,
} from './ExplorerToolbar';

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({ isFeatureEnabled: () => false, loading: false, refresh: vi.fn() }),
}));

vi.mock('@ci/shadcn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  // Radix's Select needs PointerEvent, which jsdom doesn't implement — the same
  // gotcha ThingModal.test.tsx documents. Swap in a native <select> that
  // keeps the same value/onValueChange contract, so SortControl's own wiring
  // (URL round-trip + option mapping) is still exercised for real; only the
  // unrelated Radix listbox internals are bypassed.
  function SortTrigger({ className }: { className?: string }) {
    return <span data-testid="sort-trigger" className={className} />;
  }

  function FakeSelect({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }) {
    const outside: ReactNode[] = [];
    const inside: ReactNode[] = [];

    // The trigger is a sibling of the native select: a <span> nested in
    // <select> is invalid and React warns on every toolbar render.
    Children.forEach(children, (child) => {
      if (isValidElement(child) && child.type === SortTrigger) {
        outside.push(child);

        return;
      }

      inside.push(child);
    });

    return (
      <>
        {outside}
        <select aria-label="Sort" value={value} onChange={(event) => onValueChange?.(event.target.value)}>
          {inside}
        </select>
      </>
    );
  }

  FakeSelect.Trigger = SortTrigger;
  FakeSelect.Value = () => null;
  FakeSelect.Content = ({ children }: { children?: ReactNode }) => <>{children}</>;
  FakeSelect.Item = ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  );

  return {
    ...actual,
    useToast: () => ({ toast: { success: toastSuccess, error: toastError } }),
    Select: FakeSelect,
  };
});

const SOURCE_SYSTEMS_QUERY = gql(`
  query SourceSystems($includeTypes: [String!], $excludeTypes: [String!]) {
    sourceSystems(includeTypes: $includeTypes, excludeTypes: $excludeTypes)
  }
`);

const EVENT_TYPES_QUERY = gql(`
  query EventTypes {
    eventTypes
  }
`);

// Surfaces the live URL search params in the DOM so assertions can read the
// filter state the toolbar writes without reaching into router internals.
function ParamsProbe() {
  const [params] = useSearchParams();

  return <div data-testid="params">{params.toString()}</div>;
}

function renderToolbar(ui: ReactNode, { mocks = [], ...options }: RenderWithProvidersOptions = {}) {
  return renderWithProviders(
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <ParamsProbe />
      {ui}
    </DropdownProvider>,
    {
      mocks: [
        ...mocks,
        mockQuery(SOURCE_SYSTEMS_QUERY, {}, { sourceSystems: ['gmail', 'reddit'] }),
        mockQuery(EVENT_TYPES_QUERY, {}, { eventTypes: ['messaged', 'visited'] }),
        mockQuery(
          PERSON_NAME_SUGGESTIONS_QUERY,
          { query: '', first: 8 },
          {
            people: {
              edges: [
                {
                  cursor: 'c1',
                  node: { id: 'p1', name: 'Ada Lovelace', __typename: 'PersonType' },
                  __typename: 'PersonEdge',
                },
                {
                  cursor: 'c2',
                  node: { id: 'p2', name: 'Alan Turing', __typename: 'PersonType' },
                  __typename: 'PersonEdge',
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: 'c2', __typename: 'PageInfo' },
              __typename: 'PersonConnection',
            },
          },
        ),
      ],
      ...options,
    },
  );
}

describe('ExplorerToolbar', () => {
  describe('date range', () => {
    it('applies a rolling preset from the When popover and reflects it in the URL and trigger label', () => {
      renderToolbar(<MemoryExplorerFilterControls />);

      expect(screen.getByRole('button', { name: /^When/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^When/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));

      // The trigger swaps its "When" placeholder for the active preset label...
      expect(screen.getByRole('button', { name: /Yesterday/ })).toBeInTheDocument();
      // ...and the URL carries the resolved preset plus its concrete bounds, not
      // just the preset name (so a shared/reloaded link reproduces the same range).
      const params = screen.getByTestId('params').textContent ?? '';

      expect(params).toContain('when=yesterday');
      expect(params).toMatch(/from=\d{4}-\d{2}-\d{2}T/);
      expect(params).toMatch(/to=\d{4}-\d{2}-\d{2}T/);
    });

    it('starts from an existing URL range and lets "Clear range" remove it', () => {
      // Local-midnight bounds (built the same way DateControl's own dateTimeIso
      // helper would) so the trigger shows a plain date label instead of a
      // detailed-time one — the label text itself is derived the same way the
      // component derives it, so this stays correct across the runner's TZ.
      const from = new Date(2026, 0, 1, 0, 0, 0, 0).toISOString();
      const to = new Date(2026, 0, 31, 23, 59, 59, 999).toISOString();
      const expectedLabel = `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`;

      renderToolbar(<MemoryExplorerFilterControls />, {
        route: `/?when=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      });

      // The date range is reflected in the trigger without opening the popover.
      const trigger = screen.getByRole('button', { name: expectedLabel });

      expect(trigger).toBeInTheDocument();

      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole('button', { name: 'Clear range' }));

      expect(screen.getByTestId('params').textContent).not.toMatch(/from=|to=|when=/);
      expect(screen.getByRole('button', { name: 'When' })).toBeInTheDocument();
    });

    describe('typing a custom range', () => {
      const from = new Date(2026, 0, 1, 0, 0, 0, 0).toISOString();
      const to = new Date(2026, 0, 31, 23, 59, 59, 999).toISOString();
      const route = `/?when=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const label = `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`;
      const param = (name: string) =>
        new URLSearchParams(screen.getByTestId('params').textContent ?? '').get(name);
      const routeFor = (start: Date, end: Date) => {
        const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);

        return `/?when=custom&from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(endOfDay.toISOString())}`;
      };

      const labelFor = (start: Date, end: Date) =>
        `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`;

      it('shows the range in the Start / End date fields and applies a typed date as a whole local day', () => {
        renderToolbar(<MemoryExplorerFilterControls />, { route });
        fireEvent.click(screen.getByRole('button', { name: label }));

        const start = screen.getByLabelText('Start date');
        const end = screen.getByLabelText('End date');

        expect(start).toHaveValue('2026-01-01');
        expect(end).toHaveValue('2026-01-31');

        fireEvent.change(end, { target: { value: '2026-03-15' } });

        expect(param('from')).toBe(from);
        expect(param('to')).toBe(new Date(2026, 2, 15, 23, 59, 59, 999).toISOString());
        expect(param('when')).toBe('custom');
      });

      it('waits for a four-digit year, and goes back to the applied date if the field is left before one', () => {
        renderToolbar(<MemoryExplorerFilterControls />, { route });
        fireEvent.click(screen.getByRole('button', { name: label }));

        const start = screen.getByLabelText('Start date');

        // What a date field reports part-way through typing the year 2019.
        fireEvent.change(start, { target: { value: '0020-06-01' } });
        expect(param('from')).toBe(from);

        fireEvent.blur(start);
        expect(start).toHaveValue('2026-01-01');
        expect(param('from')).toBe(from);

        fireEvent.change(start, { target: { value: '2019-06-01' } });
        expect(param('from')).toBe(new Date(2019, 5, 1, 0, 0, 0, 0).toISOString());
        expect(param('to')).toBe(to);
      });

      it('brings the other end along when a start is typed past it, and opens an end that is emptied', () => {
        renderToolbar(<MemoryExplorerFilterControls />, { route });
        fireEvent.click(screen.getByRole('button', { name: label }));

        const start = screen.getByLabelText('Start date');

        fireEvent.change(start, { target: { value: '2026-05-10' } });
        // Past the end, it waits for the field to be left rather than moving the end per keystroke.
        expect(param('from')).toBe(from);
        expect(param('to')).toBe(to);
        fireEvent.blur(start);

        expect(param('from')).toBe(new Date(2026, 4, 10, 0, 0, 0, 0).toISOString());
        expect(param('to')).toBe(new Date(2026, 4, 10, 23, 59, 59, 999).toISOString());

        const end = screen.getByLabelText('End date');

        fireEvent.change(end, { target: { value: '' } });
        fireEvent.blur(end);

        expect(param('from')).toBe(new Date(2026, 4, 10, 0, 0, 0, 0).toISOString());
        expect(param('to')).toBeNull();
      });

      it('leaves the start alone while an earlier end is typed digit by digit, then starts the range there', () => {
        renderToolbar(<MemoryExplorerFilterControls />, {
          route: routeFor(new Date(2025, 2, 1), new Date(2025, 2, 8)),
        });
        fireEvent.click(
          screen.getByRole('button', { name: labelFor(new Date(2025, 2, 1), new Date(2025, 2, 8)) }),
        );

        const end = screen.getByLabelText('End date');
        const fromBefore = param('from');
        const toBefore = param('to');

        // What the field reports while 02152025 is typed over 03/08/2025 from its month part.
        // The day digits give complete dates, all before the start; the year digits pass
        // through years under 1000 on the way back to 2025.
        for (const value of [
          '2025-02-08',
          '2025-02-01',
          '2025-02-15',
          '0002-02-15',
          '0020-02-15',
          '0202-02-15',
          '2025-02-15',
        ]) {
          fireEvent.change(end, { target: { value } });
          expect(param('from')).toBe(fromBefore);
          expect(param('to')).toBe(toBefore);
        }

        fireEvent.blur(end);

        // Committed before the start, the end begins a new one-day range on the day typed.
        expect(param('from')).toBe(new Date(2025, 1, 15, 0, 0, 0, 0).toISOString());
        expect(param('to')).toBe(new Date(2025, 1, 15, 23, 59, 59, 999).toISOString());
      });

      it('applies a held end on Enter', () => {
        renderToolbar(<MemoryExplorerFilterControls />, {
          route: routeFor(new Date(2025, 2, 1), new Date(2025, 2, 8)),
        });
        fireEvent.click(
          screen.getByRole('button', { name: labelFor(new Date(2025, 2, 1), new Date(2025, 2, 8)) }),
        );

        const end = screen.getByLabelText('End date');

        fireEvent.change(end, { target: { value: '2025-02-15' } });
        fireEvent.keyDown(end, { key: 'Enter' });

        expect(param('from')).toBe(new Date(2025, 1, 15, 0, 0, 0, 0).toISOString());
        expect(param('to')).toBe(new Date(2025, 1, 15, 23, 59, 59, 999).toISOString());
      });

      it('turns the calendar to a held date, and drops it when the popover is closed without committing', async () => {
        const range = [new Date(2025, 2, 1), new Date(2025, 2, 8)] as const;

        renderToolbar(<MemoryExplorerFilterControls />, { route: routeFor(...range) });
        fireEvent.click(screen.getByRole('button', { name: labelFor(...range) }));
        await screen.findByRole('combobox', { name: /year/i });

        const end = screen.getByLabelText('End date');

        fireEvent.change(end, { target: { value: '2024-11-20' } });
        expect(screen.getByRole('combobox', { name: /year/i })).toHaveValue('2024');
        expect(screen.getByRole('combobox', { name: /month/i })).toHaveValue('10');

        // Escape closes the popover without a blur, so the held end is never applied.
        fireEvent.keyDown(end, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByLabelText('End date')).not.toBeInTheDocument());

        const trigger = screen.getByRole('button', { name: labelFor(...range) });

        fireEvent.click(trigger);

        // Reopened, the fields show the range in force, not the date that was dropped,
        // and leaving the field does not bring that date back.
        const reopenedEnd = screen.getByLabelText('End date');

        expect(reopenedEnd).toHaveValue('2025-03-08');
        fireEvent.blur(reopenedEnd);
        expect(param('to')).toBe(new Date(2025, 2, 8, 23, 59, 59, 999).toISOString());
      });

      it('offers month and year dropdowns on the calendar and turns it to a typed date', async () => {
        renderToolbar(<MemoryExplorerFilterControls />, { route });
        fireEvent.click(screen.getByRole('button', { name: label }));

        // The grid is lazy-loaded; it opens on the range's own month.
        const year = await screen.findByRole('combobox', { name: /year/i });

        expect(year).toHaveValue('2026');
        expect(screen.getByRole('combobox', { name: /month/i })).toHaveValue('0');

        fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2019-06-01' } });

        expect(screen.getByRole('combobox', { name: /year/i })).toHaveValue('2019');
        expect(screen.getByRole('combobox', { name: /month/i })).toHaveValue('5');

        // Picking a year pages the grid without touching the applied range.
        fireEvent.change(screen.getByRole('combobox', { name: /year/i }), { target: { value: '2012' } });

        expect(screen.getByRole('combobox', { name: /year/i })).toHaveValue('2012');
        expect(param('from')).toBe(new Date(2019, 5, 1, 0, 0, 0, 0).toISOString());
      });
    });

    /**
     * QA MEM-15: on a phone the custom range's calendar, "Specific time" and
     * "Clear range" stack taller than the screen. Only the popover opened from
     * the phone filter sheet's row was capped to the room it had; the inline When
     * button's ran off the bottom edge, so expanding "Specific time" put its
     * Start / End inputs below the fold with nothing to scroll.
     */
    describe('a custom range on a short screen', () => {
      const from = new Date(2026, 0, 1, 0, 0, 0, 0).toISOString();
      const to = new Date(2026, 0, 31, 23, 59, 59, 999).toISOString();
      const route = `/?when=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const label = `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`;

      it('caps the popover to the room it has and scrolls inside it, from the inline When button too', () => {
        renderToolbar(<MemoryExplorerFilterControls />, { route });

        fireEvent.click(screen.getByRole('button', { name: label }));

        const popover = document.querySelector('[data-slot="popover-content"]');

        expect(popover).toHaveClass('max-h-(--radix-popover-content-available-height)', 'overflow-y-auto');
      });

      it('brings the Start / End time inputs into view when Specific time opens', () => {
        const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');

        try {
          renderToolbar(<MemoryExplorerFilterControls />, { route });

          fireEvent.click(screen.getByRole('button', { name: label }));
          expect(screen.queryByLabelText('Start time')).not.toBeInTheDocument();

          fireEvent.click(screen.getByRole('button', { name: /Specific time/ }));

          const startTime = screen.getByLabelText('Start time');
          const scrolled = scrollIntoView.mock.contexts.at(-1) as HTMLElement | undefined;

          expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
          // It is the row holding the two inputs that scrolls, not something
          // elsewhere in the popover.
          expect(scrolled).toContainElement(startTime);
          expect(scrolled).toContainElement(screen.getByLabelText('End time'));
        } finally {
          scrollIntoView.mockRestore();
        }
      });
    });
  });

  describe('activity picker', () => {
    it('offers Activity beside How on the everything browse and reads the URL selection', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      expect(screen.getByRole('button', { name: /^How: all/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Activity: all/ })).toBeInTheDocument();
    });

    it('labels the trigger with the selected event type', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?eventTypes=visited' });

      expect(screen.getByRole('button', { name: /^Activity: Visited/ })).toBeInTheDocument();
    });

    it('is withheld once the What bar leaves events out, since eventTypes only narrows events', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?includedEntityTypes=Content,File' });

      expect(screen.getByRole('button', { name: /^How: all/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Activity/ })).not.toBeInTheDocument();
    });

    it('stays on the events browse, whose kinds always include events', () => {
      renderToolbar(<MemoryExplorerFilterControls />, {
        route: '/memory/events?includedEntityTypes=Content',
      });

      expect(screen.getByRole('button', { name: /^Activity: all/ })).toBeInTheDocument();
    });

    it('lists the event types once opened and writes the pick to the URL', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      fireEvent.click(screen.getByRole('button', { name: /^Activity: all/ }));
      fireEvent.click(await screen.findByRole('option', { name: 'Visited' }));

      expect(screen.getByTestId('params').textContent).toContain('eventTypes=visited');
      expect(screen.getByRole('button', { name: /^Activity: Visited/ })).toBeInTheDocument();
    });

    it('narrows the list by the typed text and refuses text that is not an event type', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      fireEvent.click(screen.getByRole('button', { name: /^Activity: all/ }));
      await screen.findByRole('option', { name: 'Visited' });

      const search = screen.getByRole('textbox', { name: 'Search activities…' });

      fireEvent.change(search, { target: { value: 'vis' } });
      expect(screen.getByRole('option', { name: 'Visited' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Messaged' })).not.toBeInTheDocument();

      fireEvent.change(search, { target: { value: 'skydived' } });
      fireEvent.keyDown(search, { key: 'Enter' });

      expect(screen.queryByRole('option', { name: /skydived/ })).not.toBeInTheDocument();
      expect(screen.getByText('No activities match')).toBeInTheDocument();
      expect(screen.getByTestId('params').textContent).not.toContain('eventTypes=');
    });
  });

  describe('how picker', () => {
    it('lists the sources once opened and toggles the pick in the URL', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      fireEvent.click(screen.getByRole('button', { name: /^How: all/ }));
      fireEvent.click(await screen.findByRole('option', { name: 'Gmail' }));

      expect(screen.getByTestId('params').textContent).toContain('connectors=gmail');
      expect(screen.getByRole('button', { name: /^How: Gmail/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('option', { name: 'Gmail' }));
      expect(screen.getByTestId('params').textContent).not.toContain('connectors=');
    });

    it('keeps a URL-carried source the list no longer holds, flagged, so it can be removed', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?connectors=myspace' });

      fireEvent.click(screen.getByRole('button', { name: /^How: Myspace/ }));
      await screen.findByRole('option', { name: 'Gmail' });

      const stale = screen.getByRole('option', { name: 'Myspace' });

      expect(stale).toHaveAttribute('aria-selected', 'true');
      expect(stale.querySelector('svg.text-warning')).not.toBeNull();

      fireEvent.click(stale);
      expect(screen.getByTestId('params').textContent).not.toContain('connectors=');
    });
  });

  describe('who / where pickers', () => {
    it('offers Who and Where beside Activity while events are in play, and not otherwise', () => {
      const { unmount } = renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      expect(screen.getByRole('button', { name: /^Who: all/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Where: all/ })).toBeInTheDocument();
      unmount();

      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?includedEntityTypes=Content,File' });
      expect(screen.queryByRole('button', { name: /^Who/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Where/ })).not.toBeInTheDocument();
    });

    it('keeps Who, but not Where or Activity, on a communications-only browse', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?includedEntityTypes=Communication' });

      expect(screen.getByRole('button', { name: /^Who: all/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Where/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Activity/ })).not.toBeInTheDocument();
    });

    it('counts the map areas in the Where trigger beside the place names', () => {
      const area = '165.500000,-47.500000,179.500000,-33.500000';
      const { unmount } = renderToolbar(<MemoryExplorerFilterControls />, { route: `/memory?areas=${area}` });

      expect(screen.getByRole('button', { name: /^Where: Map Areas \(1\)/ })).toBeInTheDocument();
      unmount();

      const two = renderToolbar(<MemoryExplorerFilterControls />, {
        route: `/memory?areas=${area};1,2,3,4&places=100+Duranzo+Aisle`,
      });

      expect(
        screen.getByRole('button', { name: /^Where: 1 selected \+ Map Areas \(2\)/ }),
      ).toBeInTheDocument();
      two.unmount();

      renderToolbar(<MemoryExplorerFilterControls />, {
        route: `/memory?areas=${area}&places=Paris&places=London`,
      });
      expect(
        screen.getByRole('button', { name: /^Where: 2 selected \+ Map Areas \(1\)/ }),
      ).toBeInTheDocument();
    });

    it('lists the map areas in the Where popover, removes one, and clears names and areas together', () => {
      renderToolbar(<MemoryExplorerFilterControls />, {
        route: '/memory?areas=165.5,-47.5,179.5,-33.5;-161,18.5,-154.5,22.5&places=Paris',
      });

      fireEvent.click(screen.getByRole('button', { name: /^Where: 1 selected \+ Map Areas \(2\)/ }));
      expect(screen.getByText('Map area: 47.5°S–33.5°S, 165.5°E–179.5°E')).toBeInTheDocument();
      expect(screen.getByText('Map area: 18.5°N–22.5°N, 161.0°W–154.5°W')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Remove map area 1' }));
      expect(screen.getByTestId('params').textContent).toContain(
        'areas=-161.000000%2C18.500000%2C-154.500000%2C22.500000',
      );
      expect(screen.getByTestId('params').textContent).not.toContain('165.5');
      expect(
        screen.getByRole('button', { name: /^Where: 1 selected \+ Map Areas \(1\)/ }),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.getByTestId('params').textContent).not.toContain('areas=');
      expect(screen.getByTestId('params').textContent).not.toContain('places=');
      expect(screen.getByRole('button', { name: /^Where: all/ })).toBeInTheDocument();
    });

    it('lists people suggestions once opened and writes the pick to the URL', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
      fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }));

      expect(screen.getByTestId('params').textContent).toContain('people=Ada+Lovelace');
      expect(screen.getByRole('button', { name: /^Who: Ada Lovelace/ })).toBeInTheDocument();
    });

    it('lists the people a page at a time, fetching the next page as the end of the list comes into view', async () => {
      // The suite-wide IntersectionObserver stub never fires; capture the
      // picker's so the end of its list can be brought "into view".
      const original = globalThis.IntersectionObserver;
      const callbacks: IntersectionObserverCallback[] = [];

      class CapturingObserver {
        constructor(callback: IntersectionObserverCallback) {
          callbacks.push(callback);
        }

        observe() {}

        disconnect() {}
      }

      globalThis.IntersectionObserver = CapturingObserver as unknown as typeof IntersectionObserver;

      const edge = (cursor: string, id: string, name: string) => ({
        cursor,
        node: { id, name, __typename: 'PersonType' as const },
        __typename: 'PersonEdge' as const,
      });

      try {
        renderToolbar(<MemoryExplorerFilterControls />, {
          route: '/memory',
          mocks: [
            mockQuery(
              PERSON_NAME_SUGGESTIONS_QUERY,
              { query: '', first: 8 },
              {
                people: {
                  edges: [edge('c1', 'p1', 'Ada Lovelace'), edge('c2', 'p2', 'Alan Turing')],
                  pageInfo: { hasNextPage: true, endCursor: 'c2', __typename: 'PageInfo' },
                  __typename: 'PersonConnection',
                },
              },
            ),
            mockQuery(
              PERSON_NAME_SUGGESTIONS_QUERY,
              { query: '', first: 8, after: 'c2' },
              {
                people: {
                  edges: [edge('c3', 'p3', 'Grace Hopper')],
                  pageInfo: { hasNextPage: false, endCursor: 'c3', __typename: 'PageInfo' },
                  __typename: 'PersonConnection',
                },
              },
            ),
          ],
        });

        fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
        await screen.findByRole('option', { name: 'Alan Turing' });
        expect(screen.queryByRole('option', { name: 'Grace Hopper' })).not.toBeInTheDocument();
        expect(screen.getByText('More…')).toBeInTheDocument();

        await act(async () => {
          for (const callback of callbacks) {
            callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
          }
        });

        // The second page joins the first; nothing follows it, so the list stops asking.
        expect(await screen.findByRole('option', { name: 'Grace Hopper' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Ada Lovelace' })).toBeInTheDocument();
        expect(screen.queryByText('More…')).not.toBeInTheDocument();
      } finally {
        globalThis.IntersectionObserver = original;
      }
    });

    it('offers the From / To toggle inside Who, chips it, and clears it from the chip', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
      fireEvent.click(screen.getByRole('button', { name: 'To' }));

      expect(screen.getByTestId('params').textContent).toContain('direction=outbound');
      expect(screen.getByRole('button', { name: 'To' })).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(screen.getByRole('button', { name: 'From' }));
      expect(screen.getByTestId('params').textContent).toContain('direction=inbound');

      fireEvent.click(screen.getByRole('button', { name: 'Any' }));
      expect(screen.getByTestId('params').textContent).not.toContain('direction=');
    });

    it('reads an existing Who selection from the URL and removes it from the panel', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?people=Ada%20Lovelace' });

      fireEvent.click(screen.getByRole('button', { name: /^Who: Ada Lovelace/ }));
      fireEvent.click(screen.getByRole('option', { name: 'Ada Lovelace' }));

      expect(screen.getByTestId('params').textContent).not.toContain('people=');
    });
  });

  describe('sort control', () => {
    it('changes the sort option and round-trips the choice back from the URL', () => {
      renderToolbar(<MemoryExplorerFilterControls />);

      const select = screen.getByRole('combobox', { name: 'Sort' });

      expect(select).toHaveValue('default');

      fireEvent.change(select, { target: { value: 'newest' } });

      const params = screen.getByTestId('params').textContent ?? '';

      expect(params).toContain('sortBy=time');
      expect(params).toContain('sortOrder=desc');
      // SortControl derives its own selected option straight back from the URL,
      // so it must reflect the change rather than getting stuck on the old value.
      expect(select).toHaveValue('newest');
    });

    it('reads an existing sortBy/sortOrder pair from the URL as the active option', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/?sortBy=name&sortOrder=desc' });

      expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('name-desc');
    });

    it('sizes the trigger to the label and keeps that label left-aligned', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?view=list' });

      const trigger = screen.getByTestId('sort-trigger');

      expect(trigger).toHaveClass('w-fit');
      expect(trigger).toHaveClass('shrink-0');
      expect(trigger).toHaveClass('justify-start');
      expect(trigger).toHaveClass('text-left');
      expect(trigger.className).not.toMatch(/min-w-\[13rem\]|w-\[150px\]/);
    });

    it('defaults to Relevance on /memory and offers no time sort without a When filter', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?view=list' });

      const select = screen.getByRole('combobox', { name: 'Sort' });

      expect(select).toHaveValue('relevance');
      expect(screen.queryByRole('option', { name: 'Newest first' })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Oldest first' })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'Default' })).not.toBeInTheDocument();

      // Choosing Relevance writes nothing: the server's own ranking is the default.
      fireEvent.change(select, { target: { value: 'name-asc' } });
      fireEvent.change(select, { target: { value: 'relevance' } });

      expect(screen.getByTestId('params').textContent).toBe('view=list');
    });

    it('offers Newest / Oldest on /memory once a When filter is active', () => {
      renderToolbar(<MemoryExplorerFilterControls />, {
        route: '/memory?view=list&when=last-week&from=2026-01-01T00:00:00.000Z&to=2026-01-07T23:59:59.999Z',
      });

      const select = screen.getByRole('combobox', { name: 'Sort' });

      expect(screen.getByRole('option', { name: 'Newest first' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Oldest first' })).toBeInTheDocument();

      fireEvent.change(select, { target: { value: 'oldest' } });

      expect(screen.getByTestId('params').textContent).toContain('sortBy=time');
      expect(screen.getByTestId('params').textContent).toContain('sortOrder=asc');
    });

    it('keeps the full preset list on the events browse', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory/events?view=list' });

      expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('default');
      expect(screen.getByRole('option', { name: 'Newest first' })).toBeInTheDocument();
    });
  });

  describe('filter chips', () => {
    it('adds a "Has a location" chip via the toggle and removes it from the drop area', () => {
      renderToolbar(
        <>
          <MemoryExplorerFilterControls />
          <ExplorerToolbar open />
        </>,
      );

      // No filters applied yet — the drop area collapses to its empty prompt,
      // so there is nothing to remove.
      expect(screen.queryByLabelText(/^Remove /)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Has a location' }));

      expect(screen.getByTestId('params')).toHaveTextContent('hasLocation=1');
      const chipRemove = screen.getByRole('button', { name: 'Remove has a location' });

      expect(chipRemove).toBeInTheDocument();

      fireEvent.click(chipRemove);

      expect(screen.getByTestId('params').textContent).not.toContain('hasLocation');
      expect(screen.queryByRole('button', { name: 'Remove has a location' })).not.toBeInTheDocument();
    });

    it('keeps Clear all outside the scrolling chip row and clears every filter', () => {
      renderToolbar(<ExplorerToolbar open />, {
        route: '/?people=Ada%20Lovelace&tags=space',
      });

      const clear = screen.getByRole('button', { name: 'Clear all' });
      const drop = screen.getByLabelText('Filter drop area');

      expect(drop).not.toContainElement(clear);
      expect(drop.className).not.toContain('overflow-hidden');

      fireEvent.click(clear);

      const params = screen.getByTestId('params').textContent ?? '';

      expect(params).not.toContain('people=');
      expect(params).not.toContain('tags=');
    });

    it('removes an already-applied person filter chip, leaving the rest of the URL untouched', () => {
      renderToolbar(<ExplorerToolbar open />, {
        route: '/?people=Ada%20Lovelace&tags=space',
      });

      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.getByText('#space')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));

      const params = screen.getByTestId('params').textContent ?? '';

      expect(params).not.toContain('people=');
      // Removing one chip must not clear its neighbours.
      expect(params).toContain('tags=space');
      expect(screen.getByText('#space')).toBeInTheDocument();
    });

    /**
     * QA MEM-16: add a Who person and From, remove the person, and "From only"
     * stayed behind next to nothing. A direction with no person is a real filter —
     * the bare row direction, saved searches and the phone filter sheet's "From
     * anyone" all depend on it — so the chip stays; what was wrong is that its
     * label only made sense beside a person.
     */
    describe('the message direction chip', () => {
      it('reads "From only" beside a Who person, whose role it fixes', () => {
        renderToolbar(<ExplorerToolbar open />, { route: '/?people=Ada%20Lovelace&direction=inbound' });

        expect(screen.getByText('From only')).toBeInTheDocument();
        expect(screen.queryByText('From anyone')).not.toBeInTheDocument();
      });

      it('says what it still filters once the person is removed, and keeps filtering', () => {
        renderToolbar(<ExplorerToolbar open />, { route: '/?people=Ada%20Lovelace&direction=inbound' });

        fireEvent.click(screen.getByRole('button', { name: 'Remove Ada Lovelace' }));

        expect(screen.getByText('From anyone')).toBeInTheDocument();
        expect(screen.queryByText('From only')).not.toBeInTheDocument();
        // Still there, still counted, still removable on its own.
        expect(screen.getByTestId('params').textContent).toContain('direction=inbound');
        expect(screen.getByText('1 filter', { exact: false })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Remove message direction' }));

        expect(screen.getByTestId('params').textContent).not.toContain('direction=');
      });

      it('reads "To anyone" for a sent-messages link that names nobody', () => {
        renderToolbar(<ExplorerToolbar open />, { route: '/?direction=outbound' });

        expect(screen.getByText('To anyone')).toBeInTheDocument();
      });
    });
  });

  // VIEW-06: every view runs the same URL filter set. Where one genuinely
  // can't — the graph reads /api/graph/*, which has no semantic ranking, no
  // map viewport and no result order — the filter is shown as not applied
  // rather than dropped in silence.
  describe('filters a view cannot apply', () => {
    it('marks the graph-incompatible chips and counts them, leaving the rest alone', () => {
      renderToolbar(<ExplorerToolbar open />, {
        route: '/?view=graph&semantic=1&areas=1,2,3,4&tags=space',
      });

      expect(screen.getByLabelText(/^Semantic — not applied in this view\./)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Map area — not applied in this view\./)).toBeInTheDocument();
      // The graph does forward tags, so that chip reads normally.
      expect(screen.queryByLabelText(/^#space — not applied/)).not.toBeInTheDocument();
      expect(screen.getByText('2 not applied here', { exact: false })).toBeInTheDocument();
    });

    it('leaves every chip active in the search-backed views', () => {
      renderToolbar(<ExplorerToolbar open />, {
        route: '/?view=list&semantic=1&areas=1,2,3,4&tags=space',
      });

      expect(screen.queryByLabelText(/not applied in this view/)).not.toBeInTheDocument();
      expect(screen.queryByText('not applied here', { exact: false })).not.toBeInTheDocument();
    });

    it('counts a dropped sort even though sort is not one of the narrowing filters', () => {
      renderToolbar(<ExplorerToolbar open />, { route: '/?view=graph&semantic=1&sortBy=name' });

      // One narrowing filter is set (semantic), but two dimensions are dropped:
      // countActiveFilters ignores sort, so the dropped tally can exceed it.
      expect(screen.getByText('1 filter', { exact: false })).toBeInTheDocument();
      expect(screen.getByText('2 not applied here', { exact: false })).toBeInTheDocument();
    });

    it('marks the Semantic toggle and Sort control on the graph without disabling them', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/?view=graph' });

      expect(screen.getByRole('button', { name: /^Semantic — not applied in this view\./ })).toBeEnabled();
      // The Select itself stays live — the sort still applies the moment you
      // switch back to a list-shaped view; the marker beside it carries the why.
      expect(screen.getByRole('combobox', { name: 'Sort' })).toBeEnabled();
      expect(screen.getByRole('note', { name: /^Sort — not applied in this view\./ })).toBeInTheDocument();
      // "Has a location" is forwarded to the graph, so it stays a plain control.
      expect(screen.getByRole('button', { name: 'Has a location' })).toBeInTheDocument();
    });
  });
});

const TRIP_ID = btoa('saved-search:trip-1');

const OWN_SAVED_SEARCHES = mockQuery(
  GetSavedSearchesForPickerDocument,
  { first: 8, query: undefined },
  {
    savedSearches: {
      __typename: 'SavedSearchConnection' as const,
      totalCount: 1,
      edges: [
        {
          __typename: 'SavedSearchEdge' as const,
          node: { __typename: 'SavedSearchType' as const, id: TRIP_ID, name: 'My trip', description: null },
        },
      ],
    },
  },
);

const TRIP = mockQuery(
  GetSavedSearchDocument,
  { id: TRIP_ID },
  {
    savedSearch: {
      __typename: 'SavedSearchType' as const,
      id: TRIP_ID,
      name: 'My trip',
      description: null,
      query: 'paris',
      entityTypes: [],
      tags: ['vacation'],
      filters: null,
    },
  },
);

describe('Save this search with a loaded saved search', () => {
  // The explorer carries `?loaded_search=<raw id>` after a saved search is
  // applied (see applySavedSearchToParams). Save then offers to write the
  // current filters back over THAT search, next to saving a new one. Without
  // the marker there is only the create path — the state every search used to
  // be in, which is why editing a saved search always made another.
  function updateMock(onSave: (variables: Record<string, unknown>) => void) {
    return {
      request: { query: UPDATE_SAVED_SEARCH },
      variableMatcher: () => true,
      result: (variables: Record<string, unknown>) => {
        onSave(variables);

        return {
          data: {
            updateSavedSearch: {
              __typename: 'UpdateSavedSearchPayload',
              success: true,
              savedSearch: {
                __typename: 'SavedSearchType',
                id: TRIP_ID,
                name: 'My trip',
                description: null,
                query: 'paris',
                entityTypes: [],
                tags: ['vacation'],
                filters: null,
              },
            },
          },
        };
      },
    };
  }

  it('offers only a new save when nothing was loaded', async () => {
    renderToolbar(<AdvancedFilters />, { route: '/memory?search=paris&people=Ada' });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this search' });

    expect(within(dialog).queryByRole('button', { name: /^Update/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('writes the current filters back over the loaded search, keeping its name', async () => {
    const onSave = vi.fn();

    renderToolbar(<AdvancedFilters />, {
      route: '/memory?loaded_search=trip-1&search=paris&people=Ada&tags=vacation',
      mocks: [TRIP, updateMock(onSave)],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this search' });

    // Both ways out are offered: the loaded search by name, or a fresh one.
    const update = await within(dialog).findByRole('button', { name: 'Update “My trip”' });
    expect(within(dialog).getByRole('button', { name: 'Save as new' })).toBeDisabled();

    fireEvent.click(update);

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual({
      input: {
        id: TRIP_ID,
        name: 'My trip',
        query: 'paris',
        // No What narrowing stores no types, the same as a seed.
        entityTypes: [],
        tags: ['vacation'],
        filters: { people: ['Ada'] },
      },
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Save this search' })).not.toBeInTheDocument(),
    );
    // Still the search the explorer is showing.
    expect(screen.getByTestId('params')).toHaveTextContent('loaded_search=trip-1');
  });

  it('sends null for a cleared query and filter set rather than leaving the old ones in place', async () => {
    const onSave = vi.fn();

    // Only a tag left: the query and every secondary filter were removed.
    renderToolbar(<AdvancedFilters />, {
      route: '/memory?loaded_search=trip-1&tags=vacation',
      mocks: [TRIP, updateMock(onSave)],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save this search' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Update “My trip”' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toEqual({
      input: {
        id: TRIP_ID,
        name: 'My trip',
        query: null,
        entityTypes: [],
        tags: ['vacation'],
        filters: null,
      },
    });
  });
});

describe('SearchPanelFilters in the header search panel', () => {
  // The header box on a page outside Memory's lists, with its panel open.
  function openHeaderPanel(
    options: RenderWithProvidersOptions = {},
    onOpenSavedSearch?: (params: URLSearchParams) => void,
  ) {
    // SearchBox asks the document whether it has focus, which jsdom never reports.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    renderToolbar(
      <SearchBox
        displayResults
        openOnFocus
        results={[]}
        panelFooter={<SearchPanelFilters modal={false} onOpenSavedSearch={onOpenSavedSearch} />}
      />,
      { route: '/plan/tasks?view=board', ...options },
    );

    const input = screen.getByRole('textbox');
    fireEvent.pointerDown(input);
    fireEvent.focus(input);
  }

  it('keeps Save this search open, and the panel under it, when you click into the dialog', async () => {
    openHeaderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Save this search' });
    const name = within(dialog).getByLabelText('Name');

    // The dialog is portaled out of the panel, so this used to read as a
    // click outside it: the panel closed and took the dialog with it.
    fireEvent.pointerDown(name);
    fireEvent.change(name, { target: { value: 'Paris trip' } });

    expect(screen.getByRole('dialog', { name: 'Save this search' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByLabelText('Name')).toHaveValue('Paris trip');
    // By text: the open dialog hides the panel from the accessibility tree.
    expect(screen.getByText('Load search')).toBeInTheDocument();
  });

  it('hands a search picked from Load search to the header to open, leaving this page alone', async () => {
    const onOpenSavedSearch = vi.fn();

    openHeaderPanel({ mocks: [OWN_SAVED_SEARCHES, TRIP] }, onOpenSavedSearch);

    fireEvent.click(screen.getByRole('button', { name: /Load search/ }));
    fireEvent.click(await screen.findByText('My trip'));

    await waitFor(() => expect(onOpenSavedSearch).toHaveBeenCalledTimes(1));
    const opened: URLSearchParams = onOpenSavedSearch.mock.calls[0][0];
    expect(opened.get('search')).toBe('paris');
    expect(opened.get('tags')).toBe('vacation');
    // Nothing of this page rides along, and this page's URL is untouched.
    expect(opened.has('view')).toBe(false);
    expect(screen.getByTestId('params')).toHaveTextContent(/^view=board$/);
  });
});

// useDeviceLayout reads window.matchMedia; drive it to force the phone
// branch, the same pattern as MobileMemoryPage.test.tsx.
function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width') ? mobile : query.includes('landscape') ? !mobile : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('on a phone', () => {
  afterEach(() => {
    setViewport(false);
    document.body.style.pointerEvents = '';
  });

  it('leads the scrolling chip row with Save and ends it with Clear all instead of wrapping them', () => {
    setViewport(true);
    renderToolbar(<ExplorerToolbar open />, {
      route: '/?people=Ada%20Lovelace&tags=space',
    });

    const drop = screen.getByLabelText('Filter drop area');
    const scroller = drop.querySelector<HTMLElement>('.overflow-x-auto');
    const clear = screen.getByRole('button', { name: 'Clear all' });
    const save = screen.getByRole('button', { name: 'Save' });

    expect(scroller).not.toBeNull();
    expect(scroller).toContainElement(clear);
    expect(scroller).toContainElement(save);
    // Save first, so it is in view before anyone discovers the line scrolls;
    // then the chips; Clear all follows the last chip.
    const chip = screen.getByRole('button', { name: 'Remove Ada Lovelace' });

    expect(save.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chip.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(clear);

    const params = screen.getByTestId('params').textContent ?? '';

    expect(params).not.toContain('people=');
    expect(params).not.toContain('tags=');
  });

  it('lays the When / How / toggles / sort controls out as one sideways-scrolling line', () => {
    renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

    const row = screen.getByRole('button', { name: /^How: all/ }).parentElement;

    // Scrolls below `device:`, wraps from it — never wraps on a phone.
    expect(row).toHaveClass('max-device:overflow-x-auto', 'device:flex-wrap', 'scrollbar-none');
    expect(row).not.toHaveClass('flex-wrap');
  });

  it('opens the How picker modal, so a tap away only closes it and reaches nothing underneath', async () => {
    setViewport(true);
    renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

    fireEvent.click(screen.getByRole('button', { name: /^How: all/ }));
    await screen.findByRole('option', { name: /^gmail$/i });

    // Radix's modal layer is what swallows the outside tap: it turns pointer
    // events off for the rest of the page while the picker is open — and the
    // shield catches what that misses (map pins turn them back on).
    expect(document.body.style.pointerEvents).toBe('none');
    expect(screen.getByTestId('menu-shield')).toBeInTheDocument();
  });

  it('keeps the How picker non-modal on desktop', async () => {
    renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

    fireEvent.click(screen.getByRole('button', { name: /^How: all/ }));
    await screen.findByRole('option', { name: /^gmail$/i });

    expect(document.body.style.pointerEvents).toBe('');
  });
});
