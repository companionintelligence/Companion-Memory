import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { SEARCH_PANEL_LAYER_PROPS, SearchBox, type SearchResultItem } from './SearchBox';

const RESULTS: SearchResultItem[] = [
  { id: '1', content: <div>Result One</div> },
  { id: '2', content: <div>Result Two</div> },
];

const desktopMatchMedia = window.matchMedia;

/** A phone-width viewport, as useDeviceLayout reads it (`max-width` queries match). */
function asPhone() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = desktopMatchMedia;
});

/** The results/filter panel: the wrapper's second child, after the input box. */
function panel(): HTMLElement {
  const wrapper = screen.getByRole('textbox').closest('form')?.firstElementChild;
  const found = wrapper?.children[1];

  if (!(found instanceof HTMLElement)) {
    throw new Error('panel is not open');
  }

  return found;
}

/** The bordered box around the input. */
function inputBox(): HTMLElement {
  return screen.getByRole('textbox').closest('form')?.firstElementChild?.firstElementChild as HTMLElement;
}

describe('SearchBox', () => {
  it('renders an input with the given placeholder', () => {
    renderWithProviders(<SearchBox placeholder="Search memories" />);

    expect(screen.getByPlaceholderText('Search memories')).toBeInTheDocument();
  });

  it('debounced auto-submit fires onSearch with the typed query', async () => {
    const onSearch = vi.fn();
    renderWithProviders(<SearchBox autoSubmit autoSubmitDelay={30} onSearch={onSearch} />);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'coffee' } });

    await waitFor(() => expect(onSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'coffee' })));
  });

  it('Escape clears the input and notifies onClear', () => {
    const onClear = vi.fn();
    renderWithProviders(<SearchBox onClear={onClear} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onClear).toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('shows results and selects one on click', () => {
    const onResultSelect = vi.fn();
    renderWithProviders(<SearchBox displayResults results={RESULTS} onResultSelect={onResultSelect} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'r' } });

    expect(screen.getByText('Result One')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Result Two'));
    expect(onResultSelect).toHaveBeenCalledWith(RESULTS[1]);
  });

  it('selects the highlighted result with arrow keys + Enter when onSubmit is omitted', () => {
    const onResultSelect = vi.fn();
    renderWithProviders(<SearchBox displayResults results={RESULTS} onResultSelect={onResultSelect} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'r' } });

    fireEvent.keyDown(input, { key: 'ArrowDown' }); // highlight first result
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onResultSelect).toHaveBeenCalledWith(RESULTS[0]);
  });

  it('submits the exact typed query on Enter even when a result is highlighted', () => {
    const onSubmit = vi.fn();
    const onResultSelect = vi.fn();
    renderWithProviders(
      <SearchBox displayResults results={RESULTS} onSubmit={onSubmit} onResultSelect={onResultSelect} />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'hanzla' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // would otherwise activate a row
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSubmit).toHaveBeenCalledWith({ query: 'hanzla' });
    expect(onResultSelect).not.toHaveBeenCalled();
  });

  it('keeps the highlight on the same row (by id) across a results refresh', () => {
    const onResultSelect = vi.fn();
    const { rerender } = renderWithProviders(
      <SearchBox displayResults results={RESULTS} onResultSelect={onResultSelect} />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'r' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // highlight Result One

    // New list: a row prepended, the highlighted row's content re-rendered.
    const refreshed: SearchResultItem[] = [
      { id: '0', content: <div>New Row</div> },
      { id: '1', content: <div>Result One (updated)</div> },
      RESULTS[1],
    ];
    rerender(<SearchBox displayResults results={refreshed} onResultSelect={onResultSelect} />);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResultSelect).toHaveBeenCalledWith(refreshed[1]);
  });

  it('drops the highlight when the row disappears from a results refresh', () => {
    const onResultSelect = vi.fn();
    const { rerender } = renderWithProviders(
      <SearchBox displayResults results={RESULTS} onResultSelect={onResultSelect} />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'r' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // highlight Result One

    rerender(<SearchBox displayResults results={[RESULTS[1]]} onResultSelect={onResultSelect} />);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResultSelect).not.toHaveBeenCalled();
  });

  it('Escape unpins a pinned panel before anything else', () => {
    const onPanelUnpin = vi.fn();
    const onClear = vi.fn();
    renderWithProviders(<SearchBox panelPinned onPanelUnpin={onPanelUnpin} onClear={onClear} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onPanelUnpin).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    expect(input).toHaveValue('abc');
  });

  it('disables browser autocomplete on the search input', () => {
    renderWithProviders(<SearchBox placeholder="Search memories" />);

    expect(screen.getByPlaceholderText('Search memories')).toHaveAttribute('autocomplete', 'off');
  });

  it('renders panelFooter below results when the panel is open', () => {
    renderWithProviders(
      <SearchBox
        displayResults
        openOnFocus
        panelPinned
        results={RESULTS}
        panelFooter={<div>Advanced filters</div>}
      />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.pointerDown(input);
    fireEvent.focus(input);

    const footer = screen.getByText('Advanced filters');
    const firstResult = screen.getByText('Result One');

    expect(firstResult.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a result heading above its row, outside the row and the arrow-key order', () => {
    const onResultSelect = vi.fn();
    const results: SearchResultItem[] = [{ ...RESULTS[0], heading: 'Recent' }, RESULTS[1]];

    renderWithProviders(<SearchBox displayResults results={results} onResultSelect={onResultSelect} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'r' } });

    const heading = screen.getByText('Recent');

    expect(
      heading.compareDocumentPosition(screen.getByText('Result One')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(heading);
    expect(onResultSelect).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onResultSelect).toHaveBeenCalledWith(results[0]);
  });

  describe('fullWidthOnPhone', () => {
    function renderOpen(props: Partial<React.ComponentProps<typeof SearchBox>> = {}) {
      renderWithProviders(<SearchBox displayResults results={RESULTS} fullWidthOnPhone {...props} />);

      const input = screen.getByRole('textbox');
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'r' } });
    }

    it('spans the screen below the input on a phone, 8px in from each edge, and leaves the input its corners', () => {
      asPhone();
      renderOpen();

      expect(panel()).toHaveClass('fixed', 'rounded-xl');
      expect(panel()).not.toHaveClass('absolute');
      expect(panel().style.left).toBe('8px');
      expect(panel().style.right).toBe('8px');
      // Capped at the visible viewport so the footer can't fall under the keyboard.
      expect(panel().style.maxHeight).toContain('var(--vv-height');
      expect(inputBox()).not.toHaveClass('rounded-b-none');
    });

    it('still hangs the panel off the input at desktop widths', () => {
      renderOpen();

      expect(panel()).toHaveClass('absolute', 'top-full', 'left-0', 'right-0');
      expect(panel().style.left).toBe('');
      expect(inputBox()).toHaveClass('rounded-b-none');
    });

    it('leaves a phone panel alone for callers that did not ask for it', () => {
      asPhone();
      renderOpen({ fullWidthOnPhone: false });

      expect(panel()).toHaveClass('absolute', 'top-full');
    });
  });

  describe('a panel layer (the phone filter sheets)', () => {
    // What a browser reports while the input blurs because focus is moving to
    // another element of the page: the document has focus, and activeElement
    // is <body> (focus has left the input, not yet reached its target). jsdom
    // reports neither on its own.
    beforeEach(() => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // The layer is portaled in the app: outside the search wrapper in the DOM.
    function renderWithLayer() {
      renderWithProviders(
        <>
          <SearchBox displayResults openOnFocus results={RESULTS} panelFooter={<div>Filters row</div>} />
          <div {...SEARCH_PANEL_LAYER_PROPS} data-state="open">
            <button type="button">Inside the sheet</button>
          </div>
          <button type="button">Elsewhere</button>
        </>,
      );

      const input = screen.getByRole('textbox');
      fireEvent.pointerDown(input);
      fireEvent.focus(input);

      return input;
    }

    it('keeps the results showing while focus is in the layer', () => {
      const input = renderWithLayer();

      fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Inside the sheet' }) });

      expect(screen.getByText('Result One')).toBeInTheDocument();
      expect(screen.getByText('Filters row')).toBeInTheDocument();
    });

    it('drops the results when focus goes anywhere else, as before', () => {
      const input = renderWithLayer();

      fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });

      expect(screen.queryByText('Result One')).not.toBeInTheDocument();
      expect(screen.getByText('Filters row')).toBeInTheDocument();
    });

    it('is not an outside tap that closes the panel', () => {
      renderWithLayer();

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside the sheet' }));

      expect(screen.getByText('Filters row')).toBeInTheDocument();
    });

    it('holds the panel open for any tap while it is open, since the sheet owns that tap', () => {
      renderWithLayer();

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));

      expect(screen.getByText('Filters row')).toBeInTheDocument();
    });
  });
});
