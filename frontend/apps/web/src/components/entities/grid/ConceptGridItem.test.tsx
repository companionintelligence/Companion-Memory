import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { CONCEPT_FRAGMENT, ConceptGridItem } from './ConceptGridItem';

const makeConcept = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'ConceptType' as const,
      id: 'c1',
      name: 'Recursion',
      description: 'A function calling itself',
      ...overrides,
    },
    CONCEPT_FRAGMENT,
  );

describe('ConceptGridItem', () => {
  it('renders the concept name, description and type label', () => {
    renderWithProviders(<ConceptGridItem concept={makeConcept()} />);

    expect(screen.getByText('Recursion')).toBeInTheDocument();
    expect(screen.getByText('A function calling itself')).toBeInTheDocument();
    expect(screen.getByText('Concept')).toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<ConceptGridItem concept={makeConcept()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Recursion'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
