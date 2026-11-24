import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { GroundingSources, parseGrounding } from './GroundingSources';

const grounding = {
  status: 'retrieved',
  sources: [
    { citation: 1, text: 'Coffee with Sam on Tuesday', voice: 'own', ref: { type: 'note', id: 'note-1' } },
  ],
  citations: { cited: [1], invalid: [] },
};

describe('answer grounding disclosure', () => {
  it('shows admitted sources with a real source link, without claiming factual verification', () => {
    render(
      <MemoryRouter>
        <GroundingSources value={grounding} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByText('View 1 memory source'));
    expect(screen.getByText('Coffee with Sam on Tuesday')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute('href', '/notes/note-1');
    expect(screen.getByText(/does not verify every claim/)).toBeInTheDocument();
  });

  it('makes retrieval failures and invalid model citations visible', () => {
    render(
      <GroundingSources
        value={{ ...grounding, status: 'timeout', sources: [], citations: { cited: [99], invalid: [99] } }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Memory lookup timed out');
    expect(screen.getByText(/could not be verified: \[M99\]/)).toBeInTheDocument();
  });

  it('ignores malformed wire metadata rather than breaking the transcript', () => {
    expect(parseGrounding({ status: '__proto__', sources: [] })).toBeNull();
    expect(parseGrounding({ status: 'retrieved', sources: [null, { ref: {} }] })?.sources).toEqual([]);
  });
});
