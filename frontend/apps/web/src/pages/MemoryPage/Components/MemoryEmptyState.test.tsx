import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { MemoryEmptyState, whenFilterNudge } from './MemoryEmptyState';

describe('whenFilterNudge', () => {
  it("names one kind in the What bar's words and says what to do", () => {
    expect(whenFilterNudge(['Content'])).toBe(
      "A When filter only shows things that have a date, and Content doesn't have one. Remove the When filter to see it again.",
    );
    expect(whenFilterNudge(['Thing'])).toBe(
      "A When filter only shows things that have a date, and Things don't have one. Remove the When filter to see them again.",
    );
  });

  it('lists several kinds', () => {
    expect(whenFilterNudge(['Content', 'File', 'Note'])).toBe(
      "A When filter only shows things that have a date, and Content, Files and Notes don't have one. Remove the When filter to see them again.",
    );
  });
});

describe('MemoryEmptyState', () => {
  it('explains the When override ahead of the generic filtered message', () => {
    render(
      <MemoryRouter>
        <MemoryEmptyState filtered whenDroppedTypes={['Content']} />
      </MemoryRouter>,
    );

    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(screen.getByText(/Content doesn't have one/)).toBeInTheDocument();
    expect(screen.queryByText(/Try clearing your filters/)).not.toBeInTheDocument();
  });

  it('falls back to the generic filtered message when nothing was set aside', () => {
    render(
      <MemoryRouter>
        <MemoryEmptyState filtered whenDroppedTypes={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Try clearing your filters/)).toBeInTheDocument();
  });
});
