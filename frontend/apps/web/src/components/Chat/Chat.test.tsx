import { fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { Chat } from './Chat';

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
