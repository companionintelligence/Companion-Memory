import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { InlineEditableField } from './InlineEditableField';

describe('InlineEditableField', () => {
  it('reads as text with a pencil, and saves only after Save is clicked', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<InlineEditableField label="Address" value="1 Pier Rd" onSave={onSave} />, {
      mocks: [],
    });

    expect(screen.getByText('1 Pier Rd')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit address' }));

    const input = screen.getByRole('textbox', { name: 'Address' });
    expect(input).toHaveValue('1 Pier Rd');
    fireEvent.change(input, { target: { value: '2 Pier Rd' } });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith('2 Pier Rd');
    await waitFor(() => {
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  it('shows an empty placeholder, and starts the editor blank for a missing value', () => {
    renderWithProviders(<InlineEditableField label="Description" value={null} multiline onSave={vi.fn()} />, {
      mocks: [],
    });

    expect(screen.getByText('No description yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit description' }));

    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('');
  });

  it('Cancel discards the draft without saving', () => {
    const onSave = vi.fn();
    renderWithProviders(<InlineEditableField label="Name" value="Old" onSave={onSave} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Old')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps the editor open with the draft when the save fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Update was rejected'));
    renderWithProviders(<InlineEditableField label="Name" value="Old" onSave={onSave} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('New');
    });
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('New');
  });

  it('does not call onSave when the text is unchanged', () => {
    const onSave = vi.fn();
    renderWithProviders(<InlineEditableField label="Name" value="Same" onSave={onSave} />, { mocks: [] });

    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
