import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { JobControlsCard } from './JobControlsCard';
import type { JobControlsResponse, JobCronControl, JobQueueControl } from './useJobControls';

/**
 * The Controls card.
 *
 * Every switch here makes the appliance do less, and "does less" and "is broken"
 * look identical from the outside — so the properties worth pinning are the ones
 * that keep a deliberate choice from reading as a fault, and the ones that keep
 * an operator from picking the destructive option by accident:
 *
 *  1. **A switched-off queue says what it cost.** Not a greyed-out row: the
 *     number of jobs dropped, because a queue silently evaporating work looks
 *     exactly like a quiet queue on the dashboard above it.
 *  2. **Off and paused are told apart.** Paused loses nothing; off drops work.
 *     A card that rendered them the same way would be the most dangerous thing
 *     on the page.
 *  3. **The numbers shown are what the appliance will DO.** A cap of 8 on a
 *     queue whose code declares 1 has to say 1.
 *  4. **A protected job cannot be switched off from here**, and says why.
 */

function queue(overrides: Partial<JobQueueControl> = {}): JobQueueControl {
  return {
    name: 'search-index',
    mode: 'enabled',
    pausedByGlobal: false,
    concurrency: { value: null, default: 6, max: 6, effective: 6 },
    declaredConcurrency: null,
    role: 'web',
    interactive: false,
    categories: ['search'],
    jobTypes: [
      {
        event: 'note.created',
        label: 'Index a new note',
        category: 'search',
        description: 'Make a new note findable.',
      },
    ],
    locked: false,
    lockedReason: null,
    skippedCount: 0,
    lastSkippedAt: null,
    ...overrides,
  };
}

function cron(overrides: Partial<JobCronControl> = {}): JobCronControl {
  return {
    name: 'PlanningJobsCron.todoScan',
    cron: '0 */30 * * * *',
    mode: 'enabled',
    locked: false,
    lockedReason: null,
    skippedCount: 0,
    lastSkippedAt: null,
    ...overrides,
  };
}

function controls(overrides: Partial<JobControlsResponse> = {}): JobControlsResponse {
  return {
    global: {
      concurrency: { value: null, default: 10, max: 64, effective: 10 },
      perQueueConcurrency: { value: null, default: 6, max: 64, effective: 6 },
      nonInteractive: 'enabled',
    },
    topology: { role: 'all', queueWorkerProcesses: 1, perProcessConcurrency: 10 },
    queues: [queue()],
    crons: [cron()],
    maxConcurrency: 64,
    ...overrides,
  };
}

function renderCard(response: JobControlsResponse | null, onSave = vi.fn(async () => true)) {
  renderWithProviders(
    <JobControlsCard
      controls={response}
      loading={false}
      saving={false}
      error={null}
      jobTypes={null}
      onSave={onSave}
    />,
  );

  return { onSave };
}

/** The queues and schedules live behind disclosures so the card is not a wall. */
function openSection(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

describe('JobControlsCard global controls', () => {
  it('offers pausing background work, and says nothing is lost', () => {
    renderCard(controls());

    expect(screen.getByLabelText('Pause background work')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is lost/)).toBeInTheDocument();
  });

  it('pauses rather than disabling when the switch is flipped', async () => {
    const { onSave } = renderCard(controls());

    fireEvent.click(screen.getByLabelText('Pause background work'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ global: { nonInteractive: 'paused' } });
  });

  it('says where the appliance cap lands when there is more than one worker process', () => {
    renderCard(
      controls({
        global: {
          concurrency: { value: 12, default: 20, max: 64, effective: 12 },
          perQueueConcurrency: { value: null, default: 6, max: 64, effective: 6 },
          nonInteractive: 'enabled',
        },
        topology: { role: 'web', queueWorkerProcesses: 2, perProcessConcurrency: 6 },
      }),
    );

    // The global semaphore is per-process, so a cap of 12 on a split deployment
    // is 6 per process. A control that did not say so would be describing a
    // different appliance from the one enforcing it.
    expect(screen.getByText(/Split across 2 worker processes/)).toBeInTheDocument();
    expect(screen.getByText(/each gets 6/)).toBeInTheDocument();
  });

  it('says that the Hub CPU limit is a different ceiling, not a substitute', () => {
    renderCard(controls());

    expect(screen.getByText(/caps the/)).toHaveTextContent(/caps the queue.*Hub.*caps the container/i);
  });

  it('commits a typed concurrency on blur, not on every keystroke', async () => {
    const { onSave } = renderCard(controls());

    const input = screen.getByLabelText('Jobs at once, whole appliance');

    fireEvent.change(input, { target: { value: '4' } });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.blur(input);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ global: { concurrency: 4 } }));
  });

  it('treats an emptied box as a reset to the shipped default', async () => {
    const { onSave } = renderCard(
      controls({
        global: {
          concurrency: { value: 4, default: 10, max: 64, effective: 4 },
          perQueueConcurrency: { value: null, default: 6, max: 64, effective: 6 },
          nonInteractive: 'enabled',
        },
      }),
    );

    const input = screen.getByLabelText('Jobs at once, whole appliance');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    // Clearing the box IS the reset — there is no separate control to hunt for,
    // and null has to reach the server as a real value rather than as "unchanged".
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ global: { concurrency: null } }));
  });
});

describe('JobControlsCard queues', () => {
  it('says what is on a queue before asking anyone to switch it off', () => {
    renderCard(controls());
    openSection(/Queues/);

    expect(screen.getByText(/Index a new note/)).toBeInTheDocument();
  });

  it('reports how much work a disabled queue has dropped', () => {
    renderCard(
      controls({
        queues: [queue({ mode: 'disabled', skippedCount: 12340, lastSkippedAt: '2026-09-01T14:02:00.000Z' })],
      }),
    );
    openSection(/Queues/);

    expect(screen.getByText(/new work for this queue is dropped, not queued/i)).toBeInTheDocument();
    expect(screen.getByText(/12,340 jobs dropped/)).toBeInTheDocument();
  });

  it('describes a paused queue as keeping its work, not losing it', () => {
    renderCard(controls({ queues: [queue({ mode: 'paused' })] }));
    openSection(/Queues/);

    expect(screen.getByText(/jobs are queuing up and nothing is being worked/i)).toBeInTheDocument();
    expect(screen.queryByText(/dropped, not queued/i)).not.toBeInTheDocument();
  });

  it('points at the global switch when that is what stopped the queue', () => {
    renderCard(
      controls({
        global: {
          concurrency: { value: null, default: 10, max: 64, effective: 10 },
          perQueueConcurrency: { value: null, default: 6, max: 64, effective: 6 },
          nonInteractive: 'paused',
        },
        queues: [queue({ mode: 'paused', pausedByGlobal: true })],
      }),
    );
    openSection(/Queues/);

    // Which switch to flip to bring it back is a different answer than for a
    // queue the operator paused by name, so the row names the global control
    // instead of just saying "paused".
    expect(screen.getByText(/will run when you switch that back/)).toBeInTheDocument();
  });

  it('sends the chosen mode for the queue that was clicked', async () => {
    const { onSave } = renderCard(controls());

    openSection(/Queues/);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ queues: [{ name: 'search-index', mode: 'paused' }] }),
    );
  });

  it('will not let a protected queue be switched off', () => {
    renderCard(
      controls({
        queues: [
          queue({
            name: 'dead-letter',
            locked: true,
            lockedReason: 'Where jobs that exhausted their retries are kept.',
          }),
        ],
      }),
    );
    openSection(/Queues/);

    expect(screen.getByRole('button', { name: 'Off' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByTitle(/exhausted their retries/)).toBeInTheDocument();
  });

  it('shows a code-declared ceiling as a fixed number rather than an editable box', () => {
    renderCard(
      controls({
        queues: [
          queue({
            name: 'llm',
            interactive: true,
            declaredConcurrency: 1,
            concurrency: { value: null, default: 1, max: 1, effective: 1 },
          }),
        ],
      }),
    );
    openSection(/Queues/);

    // An editable box here would be a control that silently does nothing: the
    // declaration wins over whatever is typed.
    expect(screen.queryByLabelText('llm concurrency')).not.toBeInTheDocument();
    expect(screen.getByTitle(/declares a ceiling of 1 in code/)).toBeInTheDocument();
  });

  it('warns when a saved cap is not the number actually in force', () => {
    renderCard(
      controls({
        queues: [queue({ concurrency: { value: 8, default: 6, max: 6, effective: 6 } })],
      }),
    );
    openSection(/Queues/);

    expect(screen.getByText(/Running at 6 — a lower ceiling applies/)).toBeInTheDocument();
  });
});

describe('JobControlsCard schedules', () => {
  it('switches a schedule off by name', async () => {
    const { onSave } = renderCard(controls());

    openSection(/Schedules/);
    // The switch is identified by the schedule's human label, which
    // `describeCron` derives from the registry key `PlanningJobsCron.todoScan`.
    fireEvent.click(screen.getByRole('switch', { name: /Todo scan/i }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        crons: [{ name: 'PlanningJobsCron.todoScan', mode: 'disabled' }],
      }),
    );
  });

  it('says a disabled schedule does not run, and how many ticks it has skipped', () => {
    renderCard(controls({ crons: [cron({ mode: 'disabled', skippedCount: 42 })] }));
    openSection(/Schedules/);

    expect(screen.getByText(/this schedule does not run/i)).toBeInTheDocument();
    expect(screen.getByText(/42 ticks skipped/)).toBeInTheDocument();
  });

  it('will not let a protected schedule be switched off', () => {
    renderCard(
      controls({
        crons: [
          cron({
            name: 'JobMetricsCollector.sampleOnSchedule',
            locked: true,
            lockedReason: 'Samples the queue depths this page charts.',
          }),
        ],
      }),
    );
    openSection(/Schedules/);

    expect(screen.getByRole('switch', { name: /Job metrics sample/i })).toBeDisabled();
  });
});

describe('JobControlsCard degradation', () => {
  it('says the controls are unavailable rather than rendering an empty form', () => {
    renderCard(null);

    expect(screen.getByText(/Job controls are unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/shipped defaults/)).toBeInTheDocument();
  });
});
