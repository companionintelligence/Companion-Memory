import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChatLoader } from './ChatLoader';

describe('ChatLoader', () => {
  it('renders three animated dots', () => {
    const { container } = render(<ChatLoader />);

    expect(container.querySelectorAll('.animate-bounce')).toHaveLength(3);
  });

  it('applies a passed className to the container', () => {
    const { container } = render(<ChatLoader className="mt-4" />);

    expect(container.firstElementChild?.className).toContain('mt-4');
  });
});
