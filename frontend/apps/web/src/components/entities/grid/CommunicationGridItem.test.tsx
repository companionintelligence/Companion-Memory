import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { COMMUNICATION_FRAGMENT, CommunicationGridItem } from './CommunicationGridItem';

const makeComm = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'CommunicationType' as const,
      id: 'm1',
      subject: 'Lunch plans',
      preview: 'Are we still on for noon?',
      time: '2026-01-15T12:00:00',
      type: 'email',
      direction: 'incoming',
      from: { __typename: 'PersonType' as const, id: 'p1', name: 'Alice' },
      ...overrides,
    },
    COMMUNICATION_FRAGMENT,
  );

describe('CommunicationGridItem', () => {
  it('uses the subject as the heading and shows the preview', () => {
    renderWithProviders(<CommunicationGridItem communication={makeComm()} />);

    expect(screen.getByText('Lunch plans')).toBeInTheDocument();
    expect(screen.getByText('Are we still on for noon?')).toBeInTheDocument();
  });

  it('derives "From <sender>" for an incoming message with no subject', () => {
    renderWithProviders(<CommunicationGridItem communication={makeComm({ subject: null })} />);

    expect(screen.getByText('From Alice')).toBeInTheDocument();
  });

  it('derives "To <sender>" for an outgoing message with no subject', () => {
    renderWithProviders(
      <CommunicationGridItem communication={makeComm({ subject: null, direction: 'outgoing' })} />,
    );

    expect(screen.getByText('To Alice')).toBeInTheDocument();
  });

  it('falls back to "Message" with neither subject nor sender', () => {
    renderWithProviders(<CommunicationGridItem communication={makeComm({ subject: null, from: null })} />);

    expect(screen.getByText('Message')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<CommunicationGridItem communication={makeComm()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Lunch plans'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
