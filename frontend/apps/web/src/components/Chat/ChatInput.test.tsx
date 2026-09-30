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

  describe('local photos (an on-device vision model is answering)', () => {
    const pngFile = (name: string, contents = 'PNGDATA') => new File([contents], name, { type: 'image/png' });
    const base64 = (text: string) => btoa(text);

    it('reads a photo on the device as bare base64 and never uploads it', async () => {
      upload.mockClear();
      const onSubmit = vi.fn().mockReturnValue(true);
      const { container } = render(<ChatInput onSubmit={onSubmit} localImages />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;

      expect(input.accept).toBe('image/*');
      fireEvent.change(input, { target: { files: [pngFile('cat.png')] } });

      await waitFor(() => expect(screen.getByText('cat.png')).toBeInTheDocument());
      expect(upload).not.toHaveBeenCalled();

      const textarea = screen.getByRole('textbox');

      fireEvent.change(textarea, { target: { value: 'what is this?' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          // Bare base64 — the native plugin rejects a `data:` prefix — and no appliance file ids.
          expect.objectContaining({ message: 'what is this?', fileIds: [], images: [base64('PNGDATA')] }),
          expect.anything(),
        ),
      );
    });

    it('sends a photo with no text, with a default prompt that names it', async () => {
      const onSubmit = vi.fn().mockReturnValue(true);
      const { container } = render(<ChatInput onSubmit={onSubmit} localImages />);

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [pngFile('a.png')] },
      });
      await waitFor(() => expect(screen.getByText('a.png')).toBeInTheDocument());

      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ message: 'Describe the attached photo(s).' }),
          expect.anything(),
        ),
      );
    });

    it('drops non-image files instead of uploading them', async () => {
      upload.mockClear();
      const { container } = render(<ChatInput localImages />);

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText('note.txt')).not.toBeInTheDocument();
      expect(upload).not.toHaveBeenCalled();
    });

    it('caps a message at four photos', async () => {
      const onSubmit = vi.fn().mockReturnValue(true);
      const { container } = render(<ChatInput onSubmit={onSubmit} localImages />);
      const files = Array.from({ length: 6 }, (_, i) => pngFile(`p${i}.png`, `img${i}`));

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files },
      });

      await waitFor(() => expect(screen.getByText('p0.png')).toBeInTheDocument());
      expect(screen.getByText('p3.png')).toBeInTheDocument();
      expect(screen.queryByText('p4.png')).not.toBeInTheDocument();
    });

    it('removes a photo before sending, and clears them all after a successful send', async () => {
      const onSubmit = vi.fn().mockReturnValue(true);
      const { container } = render(<ChatInput onSubmit={onSubmit} localImages />);

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [pngFile('keep.png', 'keep'), pngFile('drop.png', 'drop')] },
      });
      await waitFor(() => expect(screen.getByText('drop.png')).toBeInTheDocument());

      fireEvent.click(screen.getByLabelText('Remove drop.png'));
      expect(screen.queryByText('drop.png')).not.toBeInTheDocument();

      const textarea = screen.getByRole('textbox');

      fireEvent.change(textarea, { target: { value: 'go' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ images: [base64('keep')] }),
          expect.anything(),
        ),
      );
      await waitFor(() => expect(screen.queryByText('keep.png')).not.toBeInTheDocument());
    });

    it('offers the normal file attach, unchanged, when no on-device vision model is answering', () => {
      const { container } = render(<ChatInput />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;

      expect(input.accept).toContain('application/pdf');
      expect(screen.getByLabelText('Attach files or images')).toBeInTheDocument();
    });
  });
});
