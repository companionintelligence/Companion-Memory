import { Children, isValidElement, type ReactNode } from 'react';

import { fireEvent, screen } from '@testing-library/react';
import { useSearchParams } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DropdownProvider } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders, type RenderWithProvidersOptions } from '@/test/renderWithProviders';

import { ExplorerToolbar, MemoryExplorerFilterControls } from './ExplorerToolbar';

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

const PERSON_NAME_SUGGESTIONS_QUERY = gql(`
  query PersonNameSuggestions($query: String, $first: Int) {
    people(query: $query, first: $first) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`);

// Surfaces the live URL search params in the DOM so assertions can read the
// filter state the toolbar writes without reaching into router internals.
function ParamsProbe() {
  const [params] = useSearchParams();

  return <div data-testid="params">{params.toString()}</div>;
}

function renderToolbar(ui: ReactNode, options: RenderWithProvidersOptions = {}) {
  return renderWithProviders(
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <ParamsProbe />
      {ui}
    </DropdownProvider>,
    {
      mocks: [
        mockQuery(SOURCE_SYSTEMS_QUERY, {}, { sourceSystems: ['gmail', 'reddit'] }),
        mockQuery(EVENT_TYPES_QUERY, {}, { eventTypes: ['messaged', 'visited'] }),
        mockQuery(
          PERSON_NAME_SUGGESTIONS_QUERY,
          { query: '', first: 8 },
          {
            people: {
              edges: [
                {
                  node: { id: 'p1', name: 'Ada Lovelace', __typename: 'PersonType' },
                  __typename: 'PersonEdge',
                },
                {
                  node: { id: 'p2', name: 'Alan Turing', __typename: 'PersonType' },
                  __typename: 'PersonEdge',
                },
              ],
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
  });

  describe('activity picker', () => {
    it('offers Activity beside How on the everything browse and reads the URL selection', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      expect(screen.getByRole('button', { name: /^How: all/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Activity: all/ })).toBeInTheDocument();
    });

    it('labels the trigger with the selected event type', () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?eventTypes=visited' });

      expect(screen.getByRole('button', { name: /^Activity: visited/ })).toBeInTheDocument();
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
      fireEvent.click(await screen.findByRole('option', { name: 'visited' }));

      expect(screen.getByTestId('params').textContent).toContain('eventTypes=visited');
      expect(screen.getByRole('button', { name: /^Activity: visited/ })).toBeInTheDocument();
    });

    it('narrows the list by the typed text and refuses text that is not an event type', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      fireEvent.click(screen.getByRole('button', { name: /^Activity: all/ }));
      await screen.findByRole('option', { name: 'visited' });

      const search = screen.getByRole('textbox', { name: 'Search activities…' });

      fireEvent.change(search, { target: { value: 'vis' } });
      expect(screen.getByRole('option', { name: 'visited' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'messaged' })).not.toBeInTheDocument();

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
      fireEvent.click(await screen.findByRole('option', { name: 'gmail' }));

      expect(screen.getByTestId('params').textContent).toContain('connectors=gmail');
      expect(screen.getByRole('button', { name: /^How: gmail/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('option', { name: 'gmail' }));
      expect(screen.getByTestId('params').textContent).not.toContain('connectors=');
    });

    it('keeps a URL-carried source the list no longer holds, flagged, so it can be removed', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory?connectors=myspace' });

      fireEvent.click(screen.getByRole('button', { name: /^How: myspace/ }));
      await screen.findByRole('option', { name: 'gmail' });

      const stale = screen.getByRole('option', { name: 'myspace' });

      expect(stale).toHaveAttribute('aria-selected', 'true');
      expect(stale.querySelector('svg.text-warning-foreground')).not.toBeNull();

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

    it('lists people suggestions once opened and writes the pick to the URL', async () => {
      renderToolbar(<MemoryExplorerFilterControls />, { route: '/memory' });

      fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
      fireEvent.click(await screen.findByRole('option', { name: 'Ada Lovelace' }));

      expect(screen.getByTestId('params').textContent).toContain('people=Ada+Lovelace');
      expect(screen.getByRole('button', { name: /^Who: Ada Lovelace/ })).toBeInTheDocument();
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
  });

  // VIEW-06: every view runs the same URL filter set. Where one genuinely
  // can't — the graph reads /api/graph/*, which has no semantic ranking, no
  // map viewport and no result order — the filter is shown as not applied
  // rather than dropped in silence.
  describe('filters a view cannot apply', () => {
    it('marks the graph-incompatible chips and counts them, leaving the rest alone', () => {
      renderToolbar(<ExplorerToolbar open />, {
        route: '/?view=graph&semantic=1&bbox=1,2,3,4&tags=space',
      });

      expect(screen.getByLabelText(/^Semantic — not applied in this view\./)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Map area — not applied in this view\./)).toBeInTheDocument();
      // The graph does forward tags, so that chip reads normally.
      expect(screen.queryByLabelText(/^#space — not applied/)).not.toBeInTheDocument();
      expect(screen.getByText('2 not applied here', { exact: false })).toBeInTheDocument();
    });

    it('leaves every chip active in the search-backed views', () => {
      renderToolbar(<ExplorerToolbar open />, {
        route: '/?view=list&semantic=1&bbox=1,2,3,4&tags=space',
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
