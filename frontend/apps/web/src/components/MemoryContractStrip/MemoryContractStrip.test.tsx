import { useConnectionMode } from '@ci/common';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MemoryContractStrip } from './MemoryContractStrip';

vi.mock('@ci/common', () => ({
  useConnectionMode: vi.fn(),
}));

const mocked = vi.mocked(useConnectionMode);

describe('MemoryContractStrip', () => {
  it('says to update the server when the health check has no contract', () => {
    mocked.mockReturnValue({
      mode: 'connected',
      contractNotice: 'server',
      isResolved: true,
      refresh: vi.fn(),
    });

    render(<MemoryContractStrip />);

    expect(screen.getByTestId('memory-contract-notice')).toHaveTextContent('Please update your Memory server.');
  });

  it('says to update the app when the server no longer accepts this one', () => {
    mocked.mockReturnValue({
      mode: 'connected',
      contractNotice: 'app',
      isResolved: true,
      refresh: vi.fn(),
    });

    render(<MemoryContractStrip />);

    expect(screen.getByTestId('memory-contract-notice')).toHaveTextContent('Please update your Memory app.');
  });

  it('stays quiet when the two sides match, or before the health check answers', () => {
    mocked.mockReturnValue({
      mode: 'connected',
      contractNotice: null,
      isResolved: true,
      refresh: vi.fn(),
    });

    const { rerender } = render(<MemoryContractStrip />);

    expect(screen.queryByTestId('memory-contract-notice')).not.toBeInTheDocument();

    mocked.mockReturnValue({
      mode: 'fresh',
      contractNotice: 'server',
      isResolved: false,
      refresh: vi.fn(),
    });
    rerender(<MemoryContractStrip />);

    expect(screen.queryByTestId('memory-contract-notice')).not.toBeInTheDocument();
  });
});
