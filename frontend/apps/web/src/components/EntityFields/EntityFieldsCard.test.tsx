import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EntityFieldsCard } from './EntityFieldsCard';

const toastError = vi.fn();

vi.mock('@ci/shadcn', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return { ...actual, useToast: () => ({ toast: { error: toastError, success: vi.fn() } }) };
});

const FIELDS = [
  { key: 'title', label: 'Title', value: 'Annual General Meeting' },
  { key: 'description', label: 'Description', value: 'Yearly meeting.', multiline: true },
];

describe('EntityFieldsCard', () => {
  it('shows the whole field set as text when not editing, not just a description', () => {
    render(<EntityFieldsCard fields={FIELDS} editMode={false} onSave={vi.fn()} />);

    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Annual General Meeting')).toBeInTheDocument();
    expect(screen.getByText('Yearly meeting.')).toBeInTheDocument();
    // Read mode is read mode: no bare editor chrome.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('marks an empty field as empty rather than rendering a blank row', () => {
    render(<EntityFieldsCard fields={[{ key: 'brand', label: 'Brand', value: '' }]} editMode={false} />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('hides an empty field in view mode when hideWhenEmpty is set', () => {
    render(
      <EntityFieldsCard
        fields={[
          { key: 'title', label: 'Title', value: 'Invoice' },
          { key: 'text', label: 'Text', value: '', multiline: true, hideWhenEmpty: true },
        ]}
        editMode={false}
      />,
    );

    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.queryByText('Text')).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('persists every field, not only the one that was touched', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onEditModeChange = vi.fn();

    render(
      <EntityFieldsCard
        fields={FIELDS}
        editMode
        onSave={onSave}
        onEditModeChange={onEditModeChange}
        resetKey="event-1"
      />,
    );

    fireEvent.change(screen.getByDisplayValue('Annual General Meeting'), {
      target: { value: 'Annual General Meeting 2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        title: 'Annual General Meeting 2026',
        description: 'Yearly meeting.',
      });
    });

    expect(onEditModeChange).toHaveBeenCalledWith(false);
  });

  it('closes without writing when nothing was changed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onEditModeChange = vi.fn();

    render(<EntityFieldsCard fields={FIELDS} editMode onSave={onSave} onEditModeChange={onEditModeChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onEditModeChange).toHaveBeenCalledWith(false);
    });

    expect(onSave).not.toHaveBeenCalled();
  });

  it('stays open with the typed text intact when the write is rejected', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Update was rejected'));
    const onEditModeChange = vi.fn();

    render(<EntityFieldsCard fields={FIELDS} editMode onSave={onSave} onEditModeChange={onEditModeChange} />);

    fireEvent.change(screen.getByDisplayValue('Annual General Meeting'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Update was rejected');
    });

    expect(toastError).toHaveBeenCalledWith('Update was rejected');
    // Closing edit mode here would throw the user's text away on a failed save.
    expect(onEditModeChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Renamed')).toBeInTheDocument();
  });

  it('discards the buffer on cancel', () => {
    const onEditModeChange = vi.fn();

    render(
      <EntityFieldsCard fields={FIELDS} editMode onSave={vi.fn()} onEditModeChange={onEditModeChange} />,
    );

    fireEvent.change(screen.getByDisplayValue('Annual General Meeting'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onEditModeChange).toHaveBeenCalledWith(false);
    expect(screen.queryByDisplayValue('Renamed')).not.toBeInTheDocument();
  });

  it('reseeds from the saved values each time edit mode reopens', () => {
    const { rerender } = render(<EntityFieldsCard fields={FIELDS} editMode onSave={vi.fn()} />);

    fireEvent.change(screen.getByDisplayValue('Annual General Meeting'), { target: { value: 'Typed' } });

    // Leave edit mode, and let a value land from elsewhere (a save made in the
    // memory drawer writes straight into the Apollo cache).
    rerender(<EntityFieldsCard fields={FIELDS} editMode={false} onSave={vi.fn()} />);

    const updated = [{ ...FIELDS[0], value: 'Updated elsewhere' }, FIELDS[1]];

    rerender(<EntityFieldsCard fields={updated} editMode onSave={vi.fn()} />);

    // Reopening must not resurrect the abandoned buffer over the newer value.
    expect(screen.getByDisplayValue('Updated elsewhere')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Typed')).not.toBeInTheDocument();
  });

  it('abandons an in-progress edit when the page switches entity', () => {
    const { rerender } = render(
      <EntityFieldsCard fields={FIELDS} editMode onSave={vi.fn()} resetKey="event-1" />,
    );

    fireEvent.change(screen.getByDisplayValue('Annual General Meeting'), { target: { value: 'Typed' } });

    const other = [
      { key: 'title', label: 'Title', value: 'Product Launch' },
      { key: 'description', label: 'Description', value: '', multiline: true },
    ];

    rerender(<EntityFieldsCard fields={other} editMode onSave={vi.fn()} resetKey="event-2" />);

    // One entity's edits must never be persisted onto the one that replaced it.
    expect(screen.getByDisplayValue('Product Launch')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Typed')).not.toBeInTheDocument();
  });

  it('renders read-only metadata alongside the fields', () => {
    render(
      <EntityFieldsCard
        fields={FIELDS}
        editMode={false}
        metaItems={[
          { label: 'Starts', value: 'Mar 15, 2026, 9:00 AM' },
          { label: 'Source', value: null },
        ]}
      />,
    );

    expect(screen.getByText('Starts')).toBeInTheDocument();
    expect(screen.getByText('Mar 15, 2026, 9:00 AM')).toBeInTheDocument();
    // Nothing recorded: the row is dropped rather than shown blank.
    expect(screen.queryByText('Source')).not.toBeInTheDocument();
  });

  it('offers no editor at all without a write path', () => {
    render(<EntityFieldsCard fields={FIELDS} editMode />);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
