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

  it('flags a saved value the known vocabulary no longer contains, in the field variant', () => {
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
    expect(screen.getByText('hasdflasdjf').closest('[class*="border-warning"]')).not.toBeNull();
    expect(screen.getByText('reddit').closest('[class*="border-warning"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove hasdflasdjf' }));
    expect(screen.getByTestId('values')).toHaveTextContent('reddit');

    // The field's own trigger opens the same picker.
    fireEvent.click(screen.getByRole('button', { name: /Add how/ }));
    expect(screen.getByRole('option', { name: 'reddit' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'gmail' })).toHaveAttribute('aria-selected', 'false');
  });

  it('clears every value from the panel', () => {
    render(<Host initial={['Ada', 'Alan']} />);

    fireEvent.click(screen.getByRole('button', { name: /^Who: 2 selected/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByTestId('values')).toHaveTextContent('');
  });
});
