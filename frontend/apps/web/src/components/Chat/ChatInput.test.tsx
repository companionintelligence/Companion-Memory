import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatInput } from './ChatInput';

const upload = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
/**
 * What `POST /api/files/upload` answers with. The real endpoint returns `[{ id }]` and nothing else, so the
 * chip must not depend on a `name` coming back — the fake echoes one by default only so the older tests keep
 * reading as they always did.
 */
const serverEcho = vi.hoisted(() => ({ names: true, collapse: false }));

vi.mock('@/components/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
  ToolsOffNotice: () => <div data-testid="tools-off-notice" />,
}));

vi.mock('@ci/shadcn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/shadcn')>()),
  useToast: () => ({ toast: { error: toastError, info: vi.fn() } }),
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
            // `collapse` is the server folding identical files in one request into a single stored file.
            setFiles(
              (serverEcho.collapse ? incoming.slice(0, 1) : incoming).map((file, index) =>
                serverEcho.names
                  ? { id: `file-${index}`, name: file.name, contentType: file.type, size: file.size }
                  : ({ id: `file-${index}` } as never),
              ),
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

  // The line that says chat has no tools sits with the model controls it is about,
  // and goes with them where the composer has none (the Capture modal has its own).
  it('shows the tools-off notice with the model controls, and not without them', () => {
    const { unmount } = render(<ChatInput />);

    expect(screen.getByTestId('tools-off-notice')).toBeInTheDocument();
    unmount();

    render(<ChatInput showModelControls={false} />);

    expect(screen.queryByTestId('tools-off-notice')).toBeNull();
    expect(screen.queryByTestId('model-selector')).toBeNull();
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

  /**
   * "Always answer on this phone" promises nothing leaves the device, but attaching uploads the file to the
   * appliance the moment it is picked — before any send is checked — and removing the chip never takes it back.
   * A phone model that cannot read photos has nothing local to do with a file, so in that mode attach must
   * explain itself and upload nothing at all.
   */
  describe('on-device-only chat (uploads blocked)', () => {
    const photo = () => new File(['PNGDATA'], 'IMG_0111.jpeg', { type: 'image/jpeg' });

    it('does not open the picker, and says why', () => {
      upload.mockClear();
      toastError.mockClear();
      const { container } = render(<ChatInput blockUploads />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const openPicker = vi.spyOn(input, 'click');

      fireEvent.click(screen.getByLabelText('Attach files or images'));

      expect(openPicker).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Companion server'));
      expect(upload).not.toHaveBeenCalled();
    });

    it('uploads nothing even if a file arrives anyway, and shows no chip for it', async () => {
      upload.mockClear();
      toastError.mockClear();
      const { container } = render(<ChatInput blockUploads />);

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [photo()] },
      });

      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(upload).not.toHaveBeenCalled();
      expect(screen.queryByText('IMG_0111.jpeg')).not.toBeInTheDocument();
    });

    it('opens the picker as before when uploads are allowed', () => {
      const { container } = render(<ChatInput />);
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const openPicker = vi.spyOn(input, 'click');

      fireEvent.click(screen.getByLabelText('Attach files or images'));

      expect(openPicker).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The upload endpoint answers `[{ id }]` — no name — so a chip built from the response read "Remove
   * undefined" and showed no filename. The name is the one the person picked.
   */
  describe('attachment chip name', () => {
    afterEach(() => {
      serverEcho.names = true;
      serverEcho.collapse = false;
    });

    it('is the picked file’s name when the server answers with only an id', async () => {
      serverEcho.names = false;
      const { container } = render(<ChatInput />);

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['x'], 'qa-red.png', { type: 'image/png' })] },
      });

      await waitFor(() => expect(screen.getByText('qa-red.png')).toBeInTheDocument());
      expect(screen.getByLabelText('Remove qa-red.png')).toBeInTheDocument();
      expect(screen.queryByLabelText('Remove undefined')).not.toBeInTheDocument();
    });

    it('keeps each picked name against the right file when several are attached together', async () => {
      serverEcho.names = false;
      const onSubmit = vi.fn().mockReturnValue(true);
      const { container } = render(<ChatInput onSubmit={onSubmit} />);

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: {
          files: [
            new File(['a'], 'a.txt', { type: 'text/plain' }),
            new File(['b'], 'b.txt', { type: 'text/plain' }),
          ],
        },
      });

      await waitFor(() => expect(screen.getByText('b.txt')).toBeInTheDocument());
      fireEvent.click(screen.getByLabelText('Remove a.txt'));

      const textarea = screen.getByRole('textbox');

      fireEvent.change(textarea, { target: { value: 'read b' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });

      // `file-1` is the id the server gave the SECOND file; removing the first chip must not have removed it.
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ fileIds: ['file-1'] }),
          expect.anything(),
        ),
      );
    });

    it('never reads "undefined" when the server folds identical files into one, so the names stop lining up', async () => {
      serverEcho.names = false;
      serverEcho.collapse = true;
      const { container } = render(<ChatInput />);

      fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
        target: {
          files: [
            new File(['same'], 'one.txt', { type: 'text/plain' }),
            new File(['same'], 'two.txt', { type: 'text/plain' }),
          ],
        },
      });

      // Two files went up, one id came back: which of the two it stands for cannot be told, so it is named
      // for what it is rather than guessed at.
      await waitFor(() => expect(screen.getByLabelText('Remove Attachment')).toBeInTheDocument());
      expect(screen.queryByLabelText('Remove undefined')).not.toBeInTheDocument();
    });
  });
});
