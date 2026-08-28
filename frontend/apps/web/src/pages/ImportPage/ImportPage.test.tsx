import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImportSurface } from './ImportPage';

// `className` is rendered, not swallowed: the ceiling this page puts on the
// region is the fix for a real layout failure (see the test below), and a mock
// that dropped the prop would let it be deleted without a red test.
vi.mock('@/components/ImportActivity', () => ({
  ImportActivity: ({ className }: { className?: string }) => <div className={className}>import activity</div>,
}));
vi.mock('./wizard/ImportWizard', () => ({
  ImportWizard: ({ scroll }: { scroll?: string }) => (
    <div>wizard surface scroll:{scroll ?? 'contained'}</div>
  ),
}));
vi.mock('./InboxPanel', () => ({ InboxPanel: () => <div>inbox surface</div> }));
vi.mock('./HistoryTab', () => ({ HistoryTab: () => <div>history surface</div> }));

/**
 * One machinery, one navigation row: the wizard's three steps are the default
 * surface (the page exists to walk someone through an import), with the Inbox
 * folder and History one click away on the same row. There is no "Import" tab
 * — the steps are it, and clicking one is the way back.
 *
 * Not a tablist: the wizard has no trigger of its own, and a tablist whose
 * selected panel has no trigger is malformed. Two toggle buttons instead.
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
  it('puts Inbox and History on the heading, not in the step row', () => {
    render(<ImportSurface />);

    const views = screen.getByRole('group', { name: /other import views/i });

    expect(views).toBeInTheDocument();
    expect(views.closest('header')).not.toBeNull();
    expect(views.closest('ol')).toBeNull();
  });

  it('switches to the Inbox', () => {
    render(<ImportSurface />);

    fireEvent.click(screen.getByRole('button', { name: /inbox/i }));
    expect(screen.getByText('inbox surface')).toBeInTheDocument();
  });

  it('switches to History, and a step button is the way back', () => {
    render(<ImportSurface />);

    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(screen.getByText('history surface')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Pick/ }));
    expect(screen.getByText(/wizard surface/)).toBeInTheDocument();
  });

  it('pressing the surface you are on returns to the wizard', () => {
    render(<ImportSurface />);

    const inbox = screen.getByRole('button', { name: /inbox/i });

    fireEvent.click(inbox);
    expect(inbox).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(inbox);
    expect(inbox).toHaveAttribute('aria-pressed', 'false');
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

  it('marks no step current while another surface is showing', () => {
    render(<ImportSurface />);

    expect(screen.getByRole('button', { name: /Pick/ })).toHaveAttribute('aria-current', 'step');

    fireEvent.click(screen.getByRole('button', { name: /inbox/i }));

    // Saying "you are on Pick" while the Inbox is on screen would be a lie.
    expect(screen.getByRole('button', { name: /Pick/ })).not.toHaveAttribute('aria-current');
  });

  // The defect this file exists to pin: the wizard holds the services you
  // picked, the export card you are on and the runs each card started. It used
  // to be UNMOUNTED on a trip to History, so coming back via the Export step
  // landed you on an Export screen with nothing in it.
  it('keeps the wizard mounted across a trip to History', () => {
    render(<ImportSurface />);

    const wizard = screen.getByText(/wizard surface/);

    fireEvent.click(screen.getByRole('button', { name: /history/i }));

    // Still in the DOM, merely hidden — so none of its state was thrown away.
    expect(wizard).toBeInTheDocument();
    expect(wizard.closest('[hidden], .hidden')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Pick/ }));
    expect(screen.getByText(/wizard surface/)).toBe(wizard);
  });
});
