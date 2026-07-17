import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { NOTE_FRAGMENT, NoteGridItem } from './NoteGridItem';

const makeNote = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'NoteType' as const,
      id: 'n1',
      title: 'Shopping list',
      content: '<p>milk &amp; eggs</p>',
      createdAt: '2026-01-15T12:00:00',
      ...overrides,
    },
    NOTE_FRAGMENT,
  );

describe('NoteGridItem', () => {
  it('renders the title and sanitised HTML content', () => {
    renderWithProviders(<NoteGridItem note={makeNote()} />);

    expect(screen.getByText('Shopping list')).toBeInTheDocument();
    expect(screen.getByText('milk & eggs')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
  });

  it('strips dangerous markup from the content', () => {
    const { container } = renderWithProviders(
      <NoteGridItem note={makeNote({ content: '<img src=x onerror="alert(1)">safe text' })} />,
    );

    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(screen.getByText('safe text')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<NoteGridItem note={makeNote()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Shopping list'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
