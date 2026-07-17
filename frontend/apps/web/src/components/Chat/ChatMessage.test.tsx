import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ChatMessage } from './ChatMessage';

describe('ChatMessage', () => {
  it('renders nothing for the tool role', () => {
    const { container } = renderWithProviders(<ChatMessage role="tool" content="x" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders a user message as markdown', () => {
    const { getByText } = renderWithProviders(<ChatMessage role="user" content="hi **there**" />);

    expect(getByText('there').tagName).toBe('STRONG');
  });

  it('renders an assistant text message', () => {
    const { getByText } = renderWithProviders(<ChatMessage role="assistant" content="the answer" />);

    expect(getByText('the answer')).toBeInTheDocument();
  });

  it('splits assistant content into think, tool and text blocks', () => {
    const content = '<think>reasoning</think><tool>{"name":"search_web"}</tool>final answer';
    const { getByText } = renderWithProviders(<ChatMessage role="assistant" content={content} />);

    expect(getByText('AI thinking')).toBeInTheDocument();
    expect(getByText('reasoning')).toBeInTheDocument();
    expect(getByText('Calling search_web...')).toBeInTheDocument();
    expect(getByText('final answer')).toBeInTheDocument();
  });

  it('renders nothing for empty assistant content', () => {
    const { container } = renderWithProviders(<ChatMessage role="assistant" content="   " />);

    expect(container).toBeEmptyDOMElement();
  });
});
