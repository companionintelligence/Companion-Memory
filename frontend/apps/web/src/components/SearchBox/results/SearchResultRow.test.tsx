import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SearchResultRow } from './SearchResultRow';

describe('SearchResultRow', () => {
  it('keeps the kind label from being pushed out by a long title and date', () => {
    render(
      <SearchResultRow
        icon={<span>icon</span>}
        title="The Advantages of Long-Distance"
        meta="12/26/2024, 7:00:00 PM"
        kind="Event"
      />,
    );

    const title = screen.getByText('The Advantages of Long-Distance');
    const kind = screen.getByText('Event');
    const row = title.closest('.flex.min-w-0');

    expect(title).toHaveClass('truncate');
    expect(kind).toHaveClass('shrink-0');
    expect(row).toHaveClass('min-w-0');
    // The date is in the document twice: under the title on a phone, beside it on desktop.
    expect(screen.getAllByText('12/26/2024, 7:00:00 PM')).toHaveLength(2);
  });
});
