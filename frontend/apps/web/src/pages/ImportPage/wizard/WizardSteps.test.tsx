import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WizardSteps } from './WizardSteps';

/**
 * The wizard's navigation row: three steps, whose state (pick/export/sync)
 * has to track where the wizard actually is, and whose Export entry is a real
 * gate, not just a visual one: clicking it before anything is picked must not
 * navigate anywhere.
 */
describe('WizardSteps', () => {
  it('marks the current step active and leaves the others reachable but not current', () => {
    render(<WizardSteps step="pick" canExport onStep={vi.fn()} />);

    const [pick, exportStep, sync] = screen.getAllByRole('button');

    expect(pick).toHaveAttribute('aria-current', 'step');
    expect(exportStep).not.toHaveAttribute('aria-current');
    expect(sync).not.toHaveAttribute('aria-current');
    expect(pick.className).toMatch(/border-primary bg-primary\/5/);
  });

  it('marks every earlier step done and shows a checkmark instead of its number', () => {
    render(<WizardSteps step="sync" canExport onStep={vi.fn()} />);

    const [pick, exportStep, sync] = screen.getAllByRole('button');

    // Done steps swap their number badge for a check icon — the number text
    // must be gone, not just relabeled.
    expect(pick.querySelector('svg')).not.toBeNull();
    expect(pick.textContent).not.toContain('1');
    expect(exportStep.querySelector('svg')).not.toBeNull();
    expect(exportStep.textContent).not.toContain('2');

    // Sync is the current step, not done — it still shows its own number.
    expect(sync).toHaveAttribute('aria-current', 'step');
    expect(sync.textContent).toContain('3');
  });

  it('navigates Pick and Sync unconditionally', () => {
    const onStep = vi.fn();

    render(<WizardSteps step="pick" canExport={false} onStep={onStep} />);

    const [pick, , sync] = screen.getAllByRole('button');

    fireEvent.click(pick);
    fireEvent.click(sync);

    expect(onStep).toHaveBeenNthCalledWith(1, 'pick');
    expect(onStep).toHaveBeenNthCalledWith(2, 'sync');
  });

  describe('the Export gate', () => {
    it('refuses to navigate to Export before anything is picked', () => {
      const onStep = vi.fn();

      render(<WizardSteps step="pick" canExport={false} onStep={onStep} />);

      fireEvent.click(screen.getAllByRole('button')[1]);

      expect(onStep).not.toHaveBeenCalled();
    });

    it('navigates to Export once something is picked', () => {
      const onStep = vi.fn();

      render(<WizardSteps step="pick" canExport onStep={onStep} />);

      fireEvent.click(screen.getAllByRole('button')[1]);

      expect(onStep).toHaveBeenCalledWith('export');
    });

    it('renders unreachable, not merely unresponsive, before anything is picked', () => {
      // The click-refusal test above proves the gate works functionally, but a
      // button that silently eats a click with zero visual sign anything was
      // gated is its own bug — indistinguishable from broken. It has to look
      // inert too: really disabled, not just hover-styled and quietly no-op.
      render(<WizardSteps step="pick" canExport={false} onStep={vi.fn()} />);

      const exportStep = screen.getAllByRole('button')[1];

      expect(exportStep).toBeDisabled();
      expect(exportStep.className).toMatch(/cursor-not-allowed/);
      expect(exportStep.className).not.toMatch(/hover:bg-muted/);
    });

    it('renders reachable, matching every other live step, once something is picked', () => {
      render(<WizardSteps step="pick" canExport onStep={vi.fn()} />);

      const exportStep = screen.getAllByRole('button')[1];

      expect(exportStep).not.toBeDisabled();
      expect(exportStep.className).not.toMatch(/cursor-not-allowed/);
    });

    it('stays clickable even while Export is the current step, once canExport is true', () => {
      // Not a gate on VIEWING the current step — only on navigating TO it —
      // but Export can only be current after it was reached with something
      // picked, so this just proves the active step remains a working button.
      const onStep = vi.fn();

      render(<WizardSteps step="export" canExport onStep={onStep} />);

      fireEvent.click(screen.getAllByRole('button')[1]);

      expect(onStep).toHaveBeenCalledWith('export');
    });
  });
});
