import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { FULL_PAGE_PATHS } from '@/pages/MemoryPage/Components/EntityDetails/EntityDetailScaffold';

import { EntityBackBar, isEntityPagePath } from './EntityBackBar';

/**
 * QA MEM-05: "Open full page" from the explorer drawer routes in place, and the
 * page it lands on had no way back on a phone — no browser Back, no swipe, and
 * the header's one left-hand control opens the menu. The explorer's filters live
 * in the URL, so a history step back is what returns to them intact.
 */

function Where() {
  const { pathname, search } = useLocation();

  return <div data-testid="where">{`${pathname}${search}`}</div>;
}

function renderBar(entries: string[], initialIndex = entries.length - 1) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      <EntityBackBar />
      <Where />
    </MemoryRouter>,
  );
}

describe('isEntityPagePath', () => {
  // The drawer's "Open full page" and this bar read two lists; this is the join.
  // A kind that gained a page without gaining a Back would be a dead end again.
  it.each(Object.entries(FULL_PAGE_PATHS))('covers the %s page the drawer opens (%s/:id)', (_type, root) => {
    expect(isEntityPagePath(`${root}/abc-123`)).toBe(true);
  });

  it.each([
    ['the Memory explorer', '/memory'],
    ['an explorer with a drawer', '/memory/content/abc-123'],
    ['a place drawer', '/memory/places/abc-123'],
    ['a list page', '/people'],
    ['a section root', '/events'],
    ['a page nested under an entity', '/events/abc-123/edit'],
    ['a settings page', '/settings/appearance'],
  ])('does not treat %s as an entity page', (_name, pathname) => {
    expect(isEntityPagePath(pathname)).toBe(false);
  });

  it('accepts a trailing slash', () => {
    expect(isEntityPagePath('/events/abc-123/')).toBe(true);
  });
});

describe('EntityBackBar', () => {
  it.each(Object.values(FULL_PAGE_PATHS))('offers a visible Back on %s/:id', (root) => {
    renderBar([`${root}/abc-123`]);

    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible();
  });

  it('offers nothing on the explorer, a list, or a drawer route', () => {
    for (const path of ['/memory', '/people', '/memory/content/abc-123']) {
      const { unmount } = renderBar([path]);

      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('returns to where you came from, with the explorer filters still in the URL', () => {
    renderBar(['/memory?includedEntityTypes=Event&from=2026-09-01', '/events/e-1']);

    expect(screen.getByTestId('where')).toHaveTextContent('/events/e-1');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('where')).toHaveTextContent(
      '/memory?includedEntityTypes=Event&from=2026-09-01',
    );
    // And the entity page's own Back is gone with the page.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('steps back one page at a time through a chain of entity pages', () => {
    renderBar(['/memory', '/events/e-1', '/people/p-1']);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/events/e-1');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/memory');
  });

  it('goes to the Memory explorer when the page was opened cold and there is nothing behind it', () => {
    // First entry of the session: `navigate(-1)` would leave the app (or do
    // nothing at all), so the fallback is the explorer — and it replaces the
    // entry, so the page cannot be backed into again.
    renderBar(['/people/p-1']);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/memory');
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });
});
