import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { JobHealthCard, type JobsSummary, type TerminalClearResult } from './JobHealthCard';

/**
 * The Clear button on a Health verdict.
 *
 * It posts an irreversible DELETE, so the two properties worth pinning are the
 * ones that decide whether an operator's consent means anything:
 *
 *  1. **The prompt describes what will actually happen.** It used to promise
 *     "every dead-lettered job on this appliance", and the server used to
 *     deliver that — deleting payloads the reaper had not copied into
 *     `ci.pipeline_dead_letters` yet, which for a queue draining at 500 rows per
 *     two minutes is most of them. The server now keeps those; a prompt still
 *     claiming otherwise would be asking for consent to a different act.
 *  2. **What was KEPT is reported.** The count on screen will not reach zero
 *     while unharvested letters remain. Unsaid, that reads as a broken button
 *     and invites the second click that the first one was designed to avoid.
 */

const SUMMARY: JobsSummary = {
  pending: 0,
  active: 0,
  retry: 0,
  completed: 0,
  failed: 4,
  deadLettered: 10,
};

function renderCard(
  onClearTerminal: (scope: 'dead-letter' | 'failed') => Promise<TerminalClearResult | undefined>,
) {
  return renderWithProviders(
    <JobHealthCard
      stateCounts={{ 'dead-letter': 10, failed: 4 }}
      categoryCounts={{ ingest: 14 }}
      crons={[]}
      loading={false}
      onSelect={() => undefined}
      onOpenSchedules={() => undefined}
      onClearTerminal={onClearTerminal}
      summary={SUMMARY}
      refreshing={false}
      error={null}
      staleSince={null}
      updatedAt={null}
      onRefresh={() => undefined}
      onSelectState={() => undefined}
    />,
  );
}

/** The Clear next to the verdict whose headline names dead letters. */
function clearButtonFor(headlineFragment: string): HTMLElement {
  const row = screen.getByText(new RegExp(headlineFragment)).closest('li');

  if (row == null) {
    throw new Error(`no verdict row for "${headlineFragment}"`);
  }

  const button = Array.from(row.querySelectorAll('button')).find((el) => el.textContent === 'Clear');

  if (button == null) {
    throw new Error(`no Clear button on the "${headlineFragment}" verdict`);
  }

  return button;
}

describe('JobHealthCard — clearing terminal jobs', () => {
  /** What `window.confirm` was asked, and what it answers. */
  let prompts: string[];
  let confirmed: boolean;

  beforeEach(() => {
    // Captured through an implementation rather than read back off a typed spy
    // handle: `vi.spyOn`'s return type cannot be named in a `let` annotation
    // without erasing the signature it is being checked against.
    prompts = [];
    confirmed = true;

    vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      prompts.push(message ?? '');

      return confirmed;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not promise to delete every dead letter, because it no longer does', async () => {
    const onClear = vi.fn(async () => ({ scope: 'dead-letter' as const, deleted: 3, retained: 7 }));

    renderCard(onClear);
    fireEvent.click(clearButtonFor('given up'));

    await waitFor(() => expect(onClear).toHaveBeenCalledWith('dead-letter'));

    const prompt = prompts[0] ?? '';

    // The old wording, and the claim the server stopped making.
    expect(prompt).not.toMatch(/every dead-lettered job/i);
    // What it actually does: only the copies already in the ledger, and it says
    // what happens to the rest rather than leaving it to be discovered.
    expect(prompt).toMatch(/already copied into Dead letters/i);
    expect(prompt).toMatch(/kept/i);
  });

  it('says how many it kept, so a number that has not reached zero is explained', async () => {
    const onClear = vi.fn(async () => ({ scope: 'dead-letter' as const, deleted: 3, retained: 7 }));

    renderCard(onClear);
    fireEvent.click(clearButtonFor('given up'));

    expect(await screen.findByText(/Cleared 3\./)).toBeInTheDocument();
    expect(screen.getByText(/7 kept until the reaper has copied them/)).toBeInTheDocument();
  });

  it('says nothing about keeping anything when nothing was kept', async () => {
    const onClear = vi.fn(async () => ({ scope: 'failed' as const, deleted: 4, retained: 0 }));

    renderCard(onClear);
    fireEvent.click(clearButtonFor('failed outright'));

    expect(await screen.findByText(/Cleared 4\./)).toBeInTheDocument();
    expect(screen.queryByText(/kept until the reaper/)).not.toBeInTheDocument();
  });

  it('claims nothing at all when the server answered with no body', async () => {
    // `fetchJson` resolves undefined for a bodiless response. "Cleared 0" would
    // be an assertion about the appliance we cannot support; silence is honest.
    const onClear = vi.fn(async () => undefined);

    renderCard(onClear);
    fireEvent.click(clearButtonFor('given up'));

    await waitFor(() => expect(onClear).toHaveBeenCalled());
    expect(screen.queryByText(/^Cleared/)).not.toBeInTheDocument();
  });

  it('says the appliance refused, rather than looking like it worked', async () => {
    // The routine rejection is a 403: `POST /jobs/clear` is appliance-wide and
    // admin-gated wherever an admin exists. Unreported, a refusal is
    // indistinguishable from the dead-letter scope deliberately keeping rows —
    // the button appears to have run and the count appears not to have moved.
    const onClear = vi.fn(async () => {
      throw new Error('This action requires an administrator account');
    });

    renderCard(onClear);
    fireEvent.click(clearButtonFor('given up'));

    expect(
      await screen.findByText(/Nothing was cleared: This action requires an administrator account/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Cleared/)).not.toBeInTheDocument();
  });

  it('posts nothing when the operator declines the prompt', async () => {
    confirmed = false;
    const onClear = vi.fn(async () => ({ scope: 'dead-letter' as const, deleted: 3, retained: 7 }));

    renderCard(onClear);
    fireEvent.click(clearButtonFor('given up'));

    expect(onClear).not.toHaveBeenCalled();
  });
});
