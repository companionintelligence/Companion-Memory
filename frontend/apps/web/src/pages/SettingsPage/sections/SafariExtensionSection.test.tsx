import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SafariExtensionSection } from './SafariExtensionSection';

describe('SafariExtensionSection', () => {
  it('tells the reviewer and user how to enable the bundled Safari extension', () => {
    render(<SafariExtensionSection />);

    expect(screen.getByText('Safari extension')).toBeInTheDocument();
    expect(screen.getAllByText(/Companion Memory/).length).toBeGreaterThan(0);
    expect(screen.getByText(/hub.ci.computer/)).toBeInTheDocument();
    expect(screen.getByText(/separate from the Memory app/i)).toBeInTheDocument();
  });
});
