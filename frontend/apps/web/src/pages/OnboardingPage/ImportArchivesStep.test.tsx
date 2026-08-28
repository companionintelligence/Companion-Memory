import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImportArchivesStep } from './ImportArchivesStep';

vi.mock('@/pages/ImportPage/ImportPage', () => ({
  ImportSurface: ({ variant }: { variant?: string }) => <div>import surface: {variant}</div>,
}));

/**
 * Importing used to be one card among ten on the connect step, behind a dialog
 * most people never opened — while it is the single richest source of memory a
 * new user has: a connector seeds the last weeks, an export seeds the last
 * decade. This step is what makes it a choice someone actually makes.
 */
describe('ImportArchivesStep', () => {
  it('hosts the real import surface in its onboarding variant', () => {
    render(<ImportArchivesStep />);

    // Not a bespoke copy of the wizard: the same surface /import hosts, which
    // is what keeps the two from drifting.
    expect(screen.getByText(/import surface: onboarding/)).toBeInTheDocument();
  });

  it('tells someone with no export yet that they can move on', () => {
    render(<ImportArchivesStep />);

    // An export is a download Google can take days to produce, so most people
    // reach this step with nothing to give it. The copy has to say so rather
    // than implying they are behind.
    expect(screen.getByText(/No export yet\? Skip/i)).toBeInTheDocument();
  });

  it('promises that leaving does not cancel a running import', () => {
    render(<ImportArchivesStep />);

    expect(screen.getByText(/keep running after setup finishes/i)).toBeInTheDocument();
  });

  it('does not trap the catalog in a nested 58vh scroller', () => {
    const { container } = render(<ImportArchivesStep />);

    expect(container.innerHTML).not.toMatch(/58vh/);
    expect(container.querySelector('.overflow-hidden')).toBeNull();
  });
});
