import type { ReactNode } from 'react';

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
  function FakeSelect({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }) {
    return (
      <select aria-label="Sort" value={value} onChange={(event) => onValueChange?.(event.target.value)}>
        {children}
      </select>
    );
  }

  FakeSelect.Trigger = () => null;
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

const EVENT_SOURCES_QUERY = gql(`
  query EventSources {
    eventSources
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
      mocks: [mockQuery(EVENT_SOURCES_QUERY, {}, { eventSources: [] })],
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
