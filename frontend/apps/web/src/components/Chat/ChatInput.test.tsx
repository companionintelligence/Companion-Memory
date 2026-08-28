import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatInput } from './ChatInput';

const upload = vi.hoisted(() => vi.fn());

vi.mock('@/components/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));

vi.mock('@/api/useUploadFile', async () => {
  const { useState } = await import('react');

  return {
    useUploadFile: () => {
      const [files, setFiles] = useState<
        Array<{ id: string; name: string; contentType: string; size: number }>
      >([]);

      return [
        { files, loading: false, error: null },
        {
          upload: async (incoming: File[]) => {
            upload(incoming);
            setFiles(
              incoming.map((file, index) => ({
                id: `file-${index}`,
                name: file.name,
                contentType: file.type,
                size: file.size,
              })),
            );

            return true;
          },
          reset: () => setFiles([]),
        },
      ];
    },
  };
});

describe('ChatInput', () => {
  it('renders the placeholder', () => {
    render(<ChatInput placeholder="Ask anything" />);

    expect(screen.getByPlaceholderText('Ask anything')).toBeInTheDocument();
  });

  it('renders composer model controls and an attach button', () => {
    render(<ChatInput />);

    expect(screen.getByTestId('model-selector')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach files or images' })).toBeInTheDocument();
  });

  it('submits the trimmed message on Enter and clears on success', async () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    render(<ChatInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'hello world', fileIds: [] }),
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

  it('applies a new initialDraft after mount', () => {
    const { rerender } = render(<ChatInput initialDraft="" />);

    expect(screen.getByRole('textbox')).toHaveValue('');

    rerender(<ChatInput initialDraft={'I\'d like to talk about "Picnic":\n\nBring snacks'} />);

    expect(screen.getByRole('textbox')).toHaveValue('I\'d like to talk about "Picnic":\n\nBring snacks');
  });

  it('uploads a selected file and sends its id with the message', async () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    const { container } = render(<ChatInput onSubmit={onSubmit} />);

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(upload).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('note.txt')).toBeInTheDocument());

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'read this' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'read this', fileIds: ['file-0'] }),
        expect.anything(),
      ),
    );
  });
});
