import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { SearchBox, type SearchResultItem } from './SearchBox';

const RESULTS: SearchResultItem[] = [
  { id: '1', content: <div>Result One</div> },
  { id: '2', content: <div>Result Two</div> },
];

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

  it('selects the highlighted result with arrow keys + Enter', () => {
    const onResultSelect = vi.fn();
    renderWithProviders(<SearchBox displayResults results={RESULTS} onResultSelect={onResultSelect} />);

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'r' } });

    fireEvent.keyDown(input, { key: 'ArrowDown' }); // highlight first result
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onResultSelect).toHaveBeenCalledWith(RESULTS[0]);
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
});
