import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FilterValuePicker, type FilterValuePickerProps } from './FilterValuePicker';

// A host that owns the values the way the toolbar (URL) and editor (form
// state) do, so the picker's add / remove / clear contract is exercised end
// to end rather than through spies alone.
function Host(props: Partial<FilterValuePickerProps> & { initial?: string[] }) {
  const [values, setValues] = useState<string[]>(props.initial ?? []);
  const { initial: _initial, ...rest } = props;

  return (
    <>
      <div data-testid="values">{values.join('|')}</div>
      <FilterValuePicker
        variant="toolbar"
        label="Who"
        options={[]}
        searchPlaceholder="Search people…"
        emptyText="No people match"
        values={values}
        onAdd={(value) => {
          if (value.length < 2) {
            return 'Use at least 2 characters.';
          }

          setValues((current) => [...current, value]);

          return null;
        }}
        onRemove={(value) => setValues((current) => current.filter((item) => item !== value))}
        onClear={() => setValues([])}
        {...rest}
      />
    </>
  );
}

describe('FilterValuePicker', () => {
  it('reads the selection back into the toolbar trigger', () => {
    const { unmount } = render(<Host />);

    expect(screen.getByRole('button', { name: /^Who: all/ })).toBeInTheDocument();
    unmount();

    render(<Host initial={['Ada']} />);
    expect(screen.getByRole('button', { name: /^Who: Ada/ })).toBeInTheDocument();
  });

  it('shows values through formatValue but adds, removes and matches the value itself', () => {
    const label = (value: string) => value.replace(/_/g, ' ').toUpperCase();

    render(
      <Host
        label="How"
        options={['amazon_music', 'gmail']}
        optionsKnown
        formatValue={label}
        searchPlaceholder="Search sources…"
        // So the trigger stays readable while the list is open.
        modal={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^How: all/ }));
    expect(screen.queryByRole('option', { name: 'amazon_music' })).not.toBeInTheDocument();

    // Typed the way it reads on screen, or the way it is stored.
    const search = screen.getByRole('textbox', { name: 'Search sources…' });

    fireEvent.change(search, { target: { value: 'amazon mu' } });
    expect(screen.getByRole('option', { name: 'AMAZON MUSIC' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'GMAIL' })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'amazon_mu' } });

    fireEvent.click(screen.getByRole('option', { name: 'AMAZON MUSIC' }));

    // The caller is handed the raw value; only the screen says otherwise.
    expect(screen.getByTestId('values')).toHaveTextContent('amazon_music');
    expect(screen.getByRole('button', { name: /^How: AMAZON MUSIC/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: 'AMAZON MUSIC' }));
    expect(screen.getByTestId('values')).toBeEmptyDOMElement();
  });

  it('asks for the next page when the end of a longer list comes into view, and only while there is one', () => {
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

    try {
      const onLoadMore = vi.fn();
      const { rerender } = render(
        <Host
          options={['Ada Lovelace', 'Alan Turing']}
          onSearch={() => undefined}
          hasMore
          onLoadMore={onLoadMore}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
      expect(screen.getByText('More…')).toBeInTheDocument();
      expect(callbacks).toHaveLength(1);

      callbacks[0]([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      expect(onLoadMore).toHaveBeenCalledTimes(1);

      rerender(
        <Host
          options={['Ada Lovelace', 'Alan Turing', 'Grace Hopper']}
          onSearch={() => undefined}
          hasMore={false}
          onLoadMore={onLoadMore}
        />,
      );
      expect(screen.queryByText('More…')).not.toBeInTheDocument();
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('adds a listed option and removes it again by toggling', () => {
    render(<Host options={['Ada Lovelace', 'Alan Turing']} />);

    fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Ada Lovelace' }));

    expect(screen.getByTestId('values')).toHaveTextContent('Ada Lovelace');
    expect(screen.getByRole('option', { name: 'Ada Lovelace' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('option', { name: 'Ada Lovelace' }));
    expect(screen.getByTestId('values')).toHaveTextContent('');
  });

  it('lets open vocabularies commit typed text as a pattern, with Enter or the offered row', () => {
    const onSearch = vi.fn();

    render(<Host options={['Ada Lovelace']} onSearch={onSearch} />);

    fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
    fireEvent.change(screen.getByLabelText('Search people…'), { target: { value: 'lov' } });

    expect(onSearch).toHaveBeenCalledWith('lov');
    fireEvent.click(screen.getByRole('option', { name: /Match names containing “lov”/ }));
    expect(screen.getByTestId('values')).toHaveTextContent('lov');

    fireEvent.change(screen.getByLabelText('Search people…'), { target: { value: 'tur' } });
    fireEvent.keyDown(screen.getByLabelText('Search people…'), { key: 'Enter' });
    expect(screen.getByTestId('values')).toHaveTextContent('lov|tur');
  });

  it('refuses typed text for a known vocabulary and narrows the list instead', () => {
    render(
      <Host
        label="How"
        options={['gmail', 'imessage', 'reddit']}
        optionsKnown
        searchPlaceholder="Search sources…"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^How: all/ }));
    fireEvent.change(screen.getByLabelText('Search sources…'), { target: { value: 'hasdflasdjf' } });

    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No people match')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search sources…'), { target: { value: 'mail' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['gmail']);

    // A single remaining match commits on Enter.
    fireEvent.keyDown(screen.getByLabelText('Search sources…'), { key: 'Enter' });
    expect(screen.getByTestId('values')).toHaveTextContent('gmail');
  });

  it('shows the host’s validation message and keeps the text for correction', () => {
    render(<Host />);

    fireEvent.click(screen.getByRole('button', { name: /^Who: all/ }));
    fireEvent.change(screen.getByLabelText('Search people…'), { target: { value: 'a' } });
    fireEvent.keyDown(screen.getByLabelText('Search people…'), { key: 'Enter' });

    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 2 characters.');
    expect(screen.getByLabelText('Search people…')).toHaveValue('a');
    expect(screen.getByTestId('values')).toHaveTextContent('');
  });

  it('explains a flagged value in the list, not with the icon alone', async () => {
    render(
      <Host
        label="How"
        initial={['hasdflasdjf']}
        options={['gmail']}
        optionsKnown
        searchPlaceholder="Search sources…"
        unknownValueHint="No connected source has this name, so this filter matches nothing."
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^How: hasdflasdjf/ }));
    const stale = screen.getByRole('option', { name: 'hasdflasdjf' });

    expect(stale.querySelector('svg.text-warning')).not.toBeNull();
    expect(screen.getByRole('option', { name: 'gmail' }).querySelector('svg.text-warning')).toBeNull();

    fireEvent.focus(stale);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'No connected source has this name, so this filter matches nothing.',
    );
  });

  it('flags a saved value the known vocabulary no longer contains, in the field variant', async () => {
    render(
      <Host
        variant="field"
        label="How"
        initial={['reddit', 'hasdflasdjf']}
        options={['gmail', 'reddit']}
        optionsKnown
        unknownValueHint="No connected source has this name, so this filter matches nothing."
      />,
    );

    expect(screen.getByText('reddit')).toBeInTheDocument();
    expect(screen.getByText('hasdflasdjf')).toBeInTheDocument();
    // The stale chip carries the warning, the live one does not.
    const staleChip = screen.getByText('hasdflasdjf').closest<HTMLElement>('[class*="border-warning"]');
    expect(staleChip).not.toBeNull();
    expect(screen.getByText('reddit').closest('[class*="border-warning"]')).toBeNull();
    // Drawn in the warning colour itself. `text-warning-foreground` is the text
    // colour for a warning FILL (white in the light theme), and the chip has none.
    expect(staleChip).toHaveClass('text-warning');

    // A keyboard user reaches the hint by focusing the chip.
    fireEvent.focus(staleChip!);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'No connected source has this name, so this filter matches nothing.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove hasdflasdjf' }));
    expect(screen.getByTestId('values')).toHaveTextContent('reddit');

    // The field's own trigger opens the same picker.
    fireEvent.click(screen.getByRole('button', { name: /Add how/ }));
    expect(screen.getByRole('option', { name: 'reddit' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'gmail' })).toHaveAttribute('aria-selected', 'false');
  });

  it('reads an extra selection beside the names and offers Clear for it alone', () => {
    const onClear = vi.fn();
    const alone = render(<Host label="Where" extraSummary="Map Areas (2)" onClear={onClear} />);

    expect(screen.getByRole('button', { name: /^Where: Map Areas \(2\)/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Where: Map Areas/ }));
    expect(screen.getByRole('button', { name: 'Clear' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    alone.unmount();

    // `initial` is read once, at mount: each wording gets its own host.
    const one = render(<Host label="Where" extraSummary="Map Areas (2)" initial={['100 Duranzo Aisle']} />);
    expect(
      screen.getByRole('button', { name: /^Where: 100 Duranzo Aisle \+ Map Areas \(2\)/ }),
    ).toBeInTheDocument();
    one.unmount();

    // Where counts a single value too: a street address is too long for the trigger.
    const counted = render(
      <Host label="Where" extraSummary="Map Areas (2)" countValues initial={['100 Duranzo Aisle']} />,
    );
    expect(screen.getByRole('button', { name: /^Where: 1 selected \+ Map Areas \(2\)/ })).toBeInTheDocument();
    counted.unmount();

    const countedAlone = render(<Host label="Where" countValues initial={['100 Duranzo Aisle']} />);
    expect(screen.getByRole('button', { name: /^Where: 1 selected$/ })).toBeInTheDocument();
    countedAlone.unmount();

    render(<Host label="Where" extraSummary="Map Areas (1)" initial={['Paris', 'London']} />);
    expect(screen.getByRole('button', { name: /^Where: 2 selected \+ Map Areas \(1\)/ })).toBeInTheDocument();
  });

  it('clears every value from the panel', () => {
    render(<Host initial={['Ada', 'Alan']} />);

    fireEvent.click(screen.getByRole('button', { name: /^Who: 2 selected/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByTestId('values')).toHaveTextContent('');
  });

  it('opens the same panel from a caller’s own trigger, handed the current values', () => {
    render(
      <Host
        initial={['Ada']}
        options={['Ada', 'Alan']}
        renderTrigger={(values) => <button type="button">{`Who row: ${values.join(', ')}`}</button>}
      />,
    );

    expect(screen.queryByRole('button', { name: /^Who: / })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Who row: Ada' }));
    fireEvent.click(screen.getByRole('option', { name: 'Alan' }));

    expect(screen.getByTestId('values')).toHaveTextContent('Ada|Alan');
    // `hidden`: the open (modal) popover hides the rest of the page from the a11y tree.
    expect(screen.getByRole('button', { name: 'Who row: Ada, Alan', hidden: true })).toBeInTheDocument();
  });
});
