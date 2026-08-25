import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImportSurface } from './ImportPage';

// `className` is rendered, not swallowed: the ceiling this page puts on the
// region is the fix for a real layout failure (see the test below), and a mock
// that dropped the prop would let it be deleted without a red test.
vi.mock('@/components/ImportActivity', () => ({
  ImportActivity: ({ className }: { className?: string }) => <div className={className}>import activity</div>,
}));
vi.mock('./wizard/ImportWizard', () => ({
  ImportWizard: ({ scroll }: { scroll?: string }) => <div>wizard surface scroll:{scroll ?? 'contained'}</div>,
}));
vi.mock('./InboxPanel', () => ({ InboxPanel: () => <div>inbox surface</div> }));
vi.mock('./HistoryTab', () => ({ HistoryTab: () => <div>history surface</div> }));

/**
 * One machinery, one navigation row: the wizard is the default surface (the
 * page exists to walk someone through an import), with the Inbox folder and
 * History one click away. Three buttons on the heading — Wizard, Inbox,
 * History — each showing its surface. The step row is the wizard's own and
 * shows only with it; it once stayed up on the other surfaces as the way
 * back, but nobody read a step as the way out of the Inbox.
 *
 * Not a tablist: a Radix Tabs unmounts the panel you leave, and the wizard's
 * state must survive a trip to History (see the last test). Plain pressed
 * buttons over a hidden-not-unmounted wizard instead.
 */
describe('ImportSurface', () => {
  // The defect the pinned region exists for: /sources/import opens on Pick — a
  // service picker — and a 13-source import could run for an hour behind it
  // with nothing on screen saying so. It has to be present on EVERY surface,
  // not just the one that happened to start the run.
  it('pins live import progress outside every panel, on every surface', () => {
    const { container } = render(<ImportSurface />);

    const surface = container.firstElementChild;
    const activity = screen.getByText('import activity');

    expect(activity).toBeInTheDocument();
    // A direct child of the surface, not of a panel. #2182 moved it from the
    // very top to below the navigation row, which changes nothing that matters;
    // moving it INSIDE the wizard/Inbox/History panel would, because it would
    // then vanish the moment you left the surface that started the run — which
    // is the entire defect this region exists for.
    expect(activity.parentElement).toBe(surface);
    // And ahead of the wizard in the column, so it shares the screen with the
    // step you are on instead of sitting below it.
    expect(
      activity.compareDocumentPosition(screen.getByText(/wizard surface/)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(screen.getByText('import activity')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /inbox/i }));
    expect(screen.getByText('import activity')).toBeInTheDocument();
  });

  /**
   * The other half of "pinned": it must not eat the page it is pinned to.
   *
   * Measured at 1280×800 with a real 13-run batch and no ceiling: the region
   * rendered 489px tall inside a 440px column that does not scroll, and the
   * step row, the source picker and the Pick step's Continue button were all
   * below the bottom of the window with no way to reach them. The cap is set
   * here rather than inside the component because it is a fact about this
   * host — the Jobs page, whose own page scrolls, deliberately passes none.
   */
  it('does not cap live progress — the path column under the tiles scrolls', () => {
    render(<ImportSurface />);

    const activity = screen.getByText('import activity');

    // The 8.5rem / 50% ceilings existed because this column did not scroll and
    // a tall region ate the catalog. The tiles stay put; everything under them
    // shares one scroller, so a long run list just pushes the picker down.
    expect(activity.className).toContain('max-h-none');
    expect(activity.className).not.toContain('sm:max-h-[8.5rem]');
    expect(activity.className).not.toContain('sm:max-h-[50%]');
  });

  it('lets the host column be the only scroller', () => {
    render(<ImportSurface />);

    const wizard = screen.getByText(/wizard surface/);
    expect(wizard).toHaveTextContent('scroll:page');
    expect(wizard.parentElement?.className).not.toMatch(/overflow-hidden/);
  });

  it('lets the onboarding host be the only scroller', () => {
    render(<ImportSurface variant="onboarding" />);

    const wizard = screen.getByText(/wizard surface/);
    expect(wizard).toHaveTextContent('scroll:page');
    expect(wizard.parentElement?.className).not.toMatch(/overflow-hidden/);
    expect(screen.queryByRole('heading', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('opens on the wizard', () => {
    render(<ImportSurface />);

    expect(screen.getByText(/wizard surface/)).toBeInTheDocument();
    expect(screen.queryByText('inbox surface')).not.toBeInTheDocument();
    expect(screen.queryByText('history surface')).not.toBeInTheDocument();
  });

  // The surface renders its own path header, because the Inbox and History
  // controls sit on it and they belong to this component's state.
  it('introduces the path above its content', () => {
    render(<ImportSurface />);

    expect(screen.getByRole('heading', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
    expect(screen.getByText(/wait hours or days/i)).toBeInTheDocument();
  });

  // Level with the name of the path they belong to, not at the end of the step
  // row — where they read as a fourth and fifth step of a sequence they are no
  // part of.
  it('puts Wizard, Inbox and History on the heading, not in the step row', () => {
    render(<ImportSurface />);

    const views = screen.getByRole('group', { name: /import views/i });

    expect(views).toBeInTheDocument();
    expect(views.closest('header')).not.toBeNull();
    expect(views.closest('ol')).toBeNull();
    expect(
      within(views)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Wizard', 'Inbox', 'History']);
    // The wizard is showing, and its button says so.
    expect(within(views).getByRole('button', { name: 'Wizard' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches to the Inbox', () => {
    render(<ImportSurface />);

    fireEvent.click(screen.getByRole('button', { name: /inbox/i }));
    expect(screen.getByText('inbox surface')).toBeInTheDocument();
  });

  it('switches to History', () => {
    render(<ImportSurface />);

    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(screen.getByText('history surface')).toBeInTheDocument();
  });

  it('the Wizard button is the obvious way back', () => {
    render(<ImportSurface />);

    const wizard = screen.getByRole('button', { name: 'Wizard' });

    fireEvent.click(screen.getByRole('button', { name: /inbox/i }));
    expect(wizard).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/wizard surface/)?.closest('.hidden')).not.toBeNull();

    fireEvent.click(wizard);
    expect(wizard).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('inbox surface')).not.toBeInTheDocument();
    expect(screen.getByText(/wizard surface/).closest('.hidden')).toBeNull();
  });

  // These used to toggle: pressing the one you were on bounced you to the
  // wizard, so a second click on Inbox — to "make sure" — silently left it.
  it('pressing the surface you are on keeps you there', () => {
    render(<ImportSurface />);

    const inbox = screen.getByRole('button', { name: /inbox/i });

    fireEvent.click(inbox);
    fireEvent.click(inbox);
    expect(inbox).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('inbox surface')).toBeInTheDocument();

    const history = screen.getByRole('button', { name: /history/i });

    fireEvent.click(history);
    fireEvent.click(history);
    expect(history).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('history surface')).toBeInTheDocument();
    expect(screen.queryByText('inbox surface')).not.toBeInTheDocument();
  });

  // A tablist whose selected panel has no trigger is malformed: Radix labels
  // every panel `aria-labelledby` its trigger id, so the wizard's panel pointed
  // at an element that had been removed.
  it('is not a tablist at all', () => {
    render(<ImportSurface />);

    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryAllByRole('tabpanel')).toHaveLength(0);
  });

  it('shows the step row only with the wizard', () => {
    render(<ImportSurface />);

    expect(screen.getByRole('button', { name: /Pick/ })).toHaveAttribute('aria-current', 'step');

    // A row of steps over the Inbox is chrome for a flow you have left — and
    // saying "you are on Pick" while the Inbox is on screen would be a lie.
    fireEvent.click(screen.getByRole('button', { name: /inbox/i }));
    expect(screen.queryByRole('button', { name: /Pick/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sync/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(screen.queryByRole('button', { name: /Pick/ })).not.toBeInTheDocument();

    // Back on the wizard it returns, at the step you were on.
    fireEvent.click(screen.getByRole('button', { name: 'Wizard' }));
    expect(screen.getByRole('button', { name: /Pick/ })).toHaveAttribute('aria-current', 'step');
  });

  // The defect this file exists to pin: the wizard holds the services you
  // picked, the export card you are on and the runs each card started. It used
  // to be UNMOUNTED on a trip to History, so coming back to the Export step
  // landed you on an Export screen with nothing in it.
  it('keeps the wizard mounted across a trip to History', () => {
    render(<ImportSurface />);

    const wizard = screen.getByText(/wizard surface/);

    fireEvent.click(screen.getByRole('button', { name: /history/i }));

    // Still in the DOM, merely hidden — so none of its state was thrown away.
    expect(wizard).toBeInTheDocument();
    expect(wizard.closest('[hidden], .hidden')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Wizard' }));
    expect(screen.getByText(/wizard surface/)).toBe(wizard);
  });
});
