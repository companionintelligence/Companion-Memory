import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatInput } from './ChatInput';

describe('ChatInput', () => {
  it('renders the placeholder', () => {
    render(<ChatInput placeholder="Ask anything" />);

    expect(screen.getByPlaceholderText('Ask anything')).toBeInTheDocument();
  });

  it('submits the trimmed message on Enter and clears on success', async () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'hello world' }),
        expect.anything(),
      ),
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('does not submit an empty message', async () => {
    const onSubmit = vi.fn();
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    // Give any async submit a chance to (not) fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the textarea while streaming', () => {
    render(<ChatInput streaming />);

    expect(screen.getByRole('textbox')).toBeDisabled();
  });
});
