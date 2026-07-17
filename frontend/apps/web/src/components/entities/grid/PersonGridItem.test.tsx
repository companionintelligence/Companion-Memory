import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { PersonGridItem, PERSON_FRAGMENT } from './PersonGridItem';

function makePerson(overrides: Record<string, unknown> = {}) {
  return makeFragmentData(
    {
      __typename: 'PersonType' as const,
      id: 'p1',
      name: 'John Doe',
      description: 'A software engineer in San Francisco.',
      ...overrides,
    },
    PERSON_FRAGMENT,
  );
}

describe('PersonGridItem', () => {
  it('renders the person name, description and type label', () => {
    renderWithProviders(<PersonGridItem person={makePerson()} />);

    expect(screen.getByText('John Doe')).toBeInTheDocument();
    expect(screen.getByText('A software engineer in San Francisco.')).toBeInTheDocument();
    expect(screen.getByText('Person')).toBeInTheDocument();
  });

  it('fires onClick when the card is clicked', () => {
    const onClick = vi.fn();
    renderWithProviders(<PersonGridItem person={makePerson()} onClick={onClick} />);

    fireEvent.click(screen.getByText('John Doe'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('prefixes a relative avatar URL with /static', () => {
    renderWithProviders(<PersonGridItem person={makePerson({ avatarUrl: '/avatars/jd.png' })} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', '/static/avatars/jd.png');
  });
});
