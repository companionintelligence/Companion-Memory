import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OutboxQueueIndicator } from './OutboxQueueIndicator';

/**
 * The only on-screen signal that captures are queued or stuck. `pending` is ambient
 * (safely on disk, draining on its own); `needsAttention` means flushing gave up and
 * only the user can resolve it — the two must never be conflated into one chip, or a
 * user staring at a neutral-looking dot has no idea something needs them.
 */

const h = vi.hoisted(() => ({
  useOutboxQueue: vi.fn(),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  useOutboxQueue: h.useOutboxQueue,
}));

function setQueue(pending: number, needsAttention: number) {
  h.useOutboxQueue.mockReturnValue({ pending, needsAttention });
}

beforeEach(() => {
  h.useOutboxQueue.mockReset();
});

describe('OutboxQueueIndicator', () => {
  it('renders nothing when the queue is empty', () => {
    setQueue(0, 0);

    const { container } = render(<OutboxQueueIndicator />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the pending count as an ambient (non-alarming) chip', () => {
    setQueue(3, 0);

    render(<OutboxQueueIndicator />);

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByLabelText('3 waiting to sync')).toBeInTheDocument();
    expect(screen.queryByLabelText(/need your attention/)).not.toBeInTheDocument();
  });

  it('shows a needs-attention chip distinct from — and alongside — the pending chip', () => {
    setQueue(2, 1);

    render(<OutboxQueueIndicator />);

    expect(screen.getByLabelText('2 waiting to sync')).toBeInTheDocument();
    const attention = screen.getByLabelText('1 need your attention');
    expect(attention).toBeInTheDocument();
    // Distinct styling is the whole point: needs-attention is not ambient. Both chips'
    // base classes carry `destructive` as a substring already (aria-invalid styling
    // shared by every Badge variant), so the check has to target the variant's actual
    // background, not just presence of the word.
    expect(attention.className).toMatch(/\bbg-destructive\b/);
    expect(screen.getByLabelText('2 waiting to sync').className).not.toMatch(/\bbg-destructive\b/);
  });

  it('shows only the needs-attention chip when nothing else is pending', () => {
    setQueue(0, 4);

    render(<OutboxQueueIndicator />);

    expect(screen.queryByLabelText(/waiting to sync/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('4 need your attention')).toBeInTheDocument();
  });

  it('pluralizes/formats through the same count for both chips at once as they change', () => {
    setQueue(1, 1);
    const { rerender } = render(<OutboxQueueIndicator />);

    expect(screen.getByLabelText('1 waiting to sync')).toBeInTheDocument();
    expect(screen.getByLabelText('1 need your attention')).toBeInTheDocument();

    setQueue(0, 0);
    rerender(<OutboxQueueIndicator />);

    expect(screen.queryByLabelText(/waiting to sync/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/need your attention/)).not.toBeInTheDocument();
  });
});
