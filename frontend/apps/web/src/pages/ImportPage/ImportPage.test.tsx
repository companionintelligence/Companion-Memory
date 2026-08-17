import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImportSurface } from './ImportPage';

vi.mock('./wizard/ImportWizard', () => ({ ImportWizard: () => <div>wizard surface</div> }));
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
  it('opens on the wizard', () => {
    render(<ImportSurface />);

    expect(screen.getByText('wizard surface')).toBeInTheDocument();
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
    expect(screen.getByText('wizard surface')).toBeInTheDocument();
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

    const wizard = screen.getByText('wizard surface');

    fireEvent.click(screen.getByRole('button', { name: /history/i }));

    // Still in the DOM, merely hidden — so none of its state was thrown away.
    expect(wizard).toBeInTheDocument();
    expect(wizard.closest('[hidden], .hidden')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Pick/ }));
    expect(screen.getByText('wizard surface')).toBe(wizard);
  });
});
