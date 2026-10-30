import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { ApprovalsPage } from './ApprovalsPage';
import type { PendingApproval } from './useApprovals';

const answer = vi.fn();
const state: {
  actions: PendingApproval[] | null;
  loading: boolean;
  error: string | null;
} = { actions: [], loading: false, error: null };

vi.mock('./useApprovals', () => ({
  useApprovals: () => ({ ...state, answer, refresh: vi.fn() }),
}));

const card = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: 'pa-1',
  intent: 'messaging.send',
  tool: 'messaging_send',
  input: { to: '+15550000', body: 'ping' },
  reason: 'destructive-requires-confirmation',
  origin: 'appliance',
  actor: 'full',
  principalName: 'app:ci-openclaw:ci-marketplace',
  status: 'proposed',
  createdAt: '2026-09-10T00:00:00.000Z',
  expiresAt: null,
  ...over,
});

describe('ApprovalsPage', () => {
  beforeEach(() => {
    answer.mockReset();
    answer.mockResolvedValue(undefined);
    state.actions = [];
    state.loading = false;
    state.error = null;
  });

  it('shows the arguments, not just the intent — consent to a category is not consent', () => {
    // `ci.pending_actions` stores `input` as jsonb, unlike the invocation ledger
    // which deliberately stores none. This page is the one surface that can show
    // WHAT would happen, and approving a send without seeing the recipient would
    // be approving the idea of sending.
    state.actions = [card()];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText(/messaging\.send/)).toBeInTheDocument();
    expect(screen.getByText(/\+15550000/)).toBeInTheDocument();
    expect(screen.getByText(/ping/)).toBeInTheDocument();
  });

  it('explains itself from the policy reason, never from prose', () => {
    // The copy is keyed on ToolGateReason, which the server derives from the
    // intent's declared privacy label. Nothing the agent wrote reaches this card.
    state.actions = [card({ reason: 'external-leaves-appliance' })];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText(/sends data to a third party/i)).toBeInTheDocument();
  });

  it('says a write waits because chat made it right after a lookup', () => {
    state.actions = [
      card({
        intent: 'planning.createTask',
        tool: 'planning_createTask',
        input: { title: 'Call the plumber' },
        reason: 'write-after-lookup',
      }),
    ];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText(/right after looking something up/i)).toBeInTheDocument();
    expect(screen.queryByText(/irreversible/i)).not.toBeInTheDocument();
  });

  it('says an outside read waits because chat made it right after a lookup', () => {
    state.actions = [
      card({
        intent: 'messaging.listMessages',
        tool: 'messaging_listMessages',
        input: { chatGuid: 'iMessage;-;+15550000' },
        reason: 'read-after-lookup',
      }),
    ];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText(/outside service right after looking something up/i)).toBeInTheDocument();
    expect(screen.queryByText(/irreversible/i)).not.toBeInTheDocument();
  });

  it('shows what an approved read returned, since chat never gets it back', async () => {
    answer.mockResolvedValue({ success: true, data: { messages: [{ text: 'see you at 6' }] } });
    state.actions = [card({ intent: 'messaging.listMessages', reason: 'read-after-lookup' })];
    renderWithProviders(<ApprovalsPage />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/see you at 6/));
    expect(screen.getByRole('status')).toHaveTextContent(/messaging\.listMessages/);
  });

  it('says so when an approved run failed, though the request itself succeeded', async () => {
    answer.mockResolvedValue({
      success: false,
      error: { code: 'TOOL_FAILED', message: 'BlueBubbles timed out' },
    });
    state.actions = [card()];
    renderWithProviders(<ApprovalsPage />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed: BlueBubbles timed out/));
  });

  it('falls back to a conservative sentence for a reason it does not know', () => {
    // A gate reason added later must read as "something serious" before anyone
    // writes its copy — not as a raw slug.
    state.actions = [card({ reason: 'a-new-gate-reason' as PendingApproval['reason'] })];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText(/irreversible and needs your say-so/i)).toBeInTheDocument();
    expect(screen.queryByText(/a-new-gate-reason/)).not.toBeInTheDocument();
  });

  it('answers approve and decline through the same path', async () => {
    state.actions = [card()];
    renderWithProviders(<ApprovalsPage />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('pa-1', 'approve'));

    fireEvent.click(screen.getByRole('button', { name: /decline/i }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith('pa-1', 'decline'));
  });

  it('surfaces a failed approval instead of letting the card just vanish', async () => {
    // Approving RE-RUNS the intent, so a failure here can mean the run failed.
    // An owner who tapped Approve and saw the card disappear would reasonably
    // believe it worked.
    answer.mockRejectedValue(new Error('BlueBubbles unreachable'));
    state.actions = [card()];
    renderWithProviders(<ApprovalsPage />);

    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/BlueBubbles unreachable/));
  });

  it('names the app that asked, not just the authority it held', () => {
    // "full" alone asks the owner to authorise an anonymous caller holding broad
    // authority — the least answerable form of the question.
    state.actions = [card()];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText('OpenClaw')).toBeInTheDocument();
  });

  it('falls back to the slug for an app it has no label for', () => {
    // A newly installed app must be nameable on the day it ships. The slug is a
    // worse label than "OpenClaw" and a far better one than nothing.
    state.actions = [card({ principalName: 'app:ci-something:ci-marketplace' })];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText('ci-something')).toBeInTheDocument();
  });

  it('says "You" when the owner proposed it themselves', () => {
    // principalName is null for an owner-proposed action — not every card comes
    // from an app, and one that says "OpenClaw" when it was the trust dial would
    // be a lie about provenance.
    state.actions = [card({ principalName: null })];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('reads an empty queue as reassurance, not as a missing feature', () => {
    state.actions = [];
    renderWithProviders(<ApprovalsPage />);

    expect(screen.getByText(/nothing is waiting/i)).toBeInTheDocument();
  });
});
