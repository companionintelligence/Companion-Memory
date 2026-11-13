import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { BROWSER_ACTIVITY_FRAGMENT, BrowserActivityGridItem } from './BrowserActivityGridItem';

const makeActivity = (overrides: Record<string, unknown> = {}) =>
  makeFragmentData(
    {
      __typename: 'BrowserActivityType' as const,
      id: 'b1',
      title: 'Vitest docs',
      url: 'https://vitest.dev/guide/',
      ...overrides,
    },
    BROWSER_ACTIVITY_FRAGMENT,
  );

describe('BrowserActivityGridItem', () => {
  it('shows the title and links to the page by hostname', () => {
    renderWithProviders(<BrowserActivityGridItem browserActivity={makeActivity()} />);

    expect(screen.getByText('Vitest docs')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'vitest.dev' });
    expect(link).toHaveAttribute('href', 'https://vitest.dev/guide/');
  });

  it('shows a stored string that is not a web address as text, not as a link', () => {
    renderWithProviders(<BrowserActivityGridItem browserActivity={makeActivity({ url: 'not a url' })} />);

    expect(screen.getByText('not a url')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('does not repeat the title when an import stored it as the address', () => {
    renderWithProviders(
      <BrowserActivityGridItem
        browserActivity={makeActivity({ title: 'Explored on Google Maps', url: 'Explored on Google Maps' })}
      />,
    );

    expect(screen.getAllByText('Explored on Google Maps')).toHaveLength(1);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('fires onClick', () => {
    const onClick = vi.fn();
    renderWithProviders(<BrowserActivityGridItem browserActivity={makeActivity()} onClick={onClick} />);

    fireEvent.click(screen.getByText('Vitest docs'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
