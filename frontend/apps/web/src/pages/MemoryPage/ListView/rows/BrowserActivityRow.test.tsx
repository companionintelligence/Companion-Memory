import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { BROWSER_ACTIVITY_FRAGMENT, BrowserActivityRow } from './BrowserActivityRow';

function makeActivity(overrides: Record<string, unknown> = {}) {
  return makeFragmentData(
    {
      __typename: 'BrowserActivityType' as const,
      id: 'b1',
      title: 'Vitest docs',
      url: 'https://vitest.dev/guide/',
      ...overrides,
    },
    BROWSER_ACTIVITY_FRAGMENT,
  );
}

describe('BrowserActivityRow', () => {
  it('links a web address by host and path', () => {
    renderWithProviders(<BrowserActivityRow browserActivity={makeActivity()} />);

    expect(screen.getByRole('link', { name: 'vitest.dev/guide/' })).toHaveAttribute(
      'href',
      'https://vitest.dev/guide/',
    );
  });

  it('does not link the title an import stored in place of an address', () => {
    // A Google My Activity entry with only an action. As a link it opened
    // Memory's own 404 page at /Explored%20on%20Google%20Maps.
    renderWithProviders(
      <BrowserActivityRow
        browserActivity={makeActivity({ title: 'Explored on Google Maps', url: 'Explored on Google Maps' })}
      />,
    );

    expect(screen.getAllByText('Explored on Google Maps')).toHaveLength(1);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows other stored text plainly', () => {
    renderWithProviders(
      <BrowserActivityRow browserActivity={makeActivity({ title: 'Lanier', url: 'around Lanier' })} />,
    );

    expect(screen.getByText('around Lanier')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
