import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { namedChatContext } from '@/lib/agentChat';

import { useChatAboutActions } from './useChatAboutActions';

const h = vi.hoisted(() => ({
  createDispatchJob: vi.fn(async () => ({ threadId: 'thread-1' })),
  harnesses: [] as AgentHarnessStatus[],
}));

vi.mock('@/api/useAgentHarnesses', () => ({
  useAgentHarnesses: () => ({ harnesses: h.harnesses, loading: false }),
}));

vi.mock('@/api/useDispatchJob', () => ({
  createDispatchJob: h.createDispatchJob,
}));

vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useAuth: () => [{ authToken: 'test-token' }],
}));

const openclaw: AgentHarnessStatus = {
  id: 'openclaw',
  name: 'OpenClaw',
  connectedToMemory: true,
  installed: true,
  running: true,
  openUrl: 'https://openclaw.example/chat',
  accessible: true,
  wakeable: true,
  dispatchReady: true,
  dispatchBlocker: null,
  connectUrl: null,
};

/**
 * ═══ THE DISPATCH BUTTON SENT AN ID THE ENDPOINT CANNOT PARSE ═══
 *
 * `Task.tsx` builds its chat context from `TaskRowFragment.id`, which is a
 * GraphQL global id — `base64("task:<uuid>")`. `POST /v1/agent/jobs` validates
 * `taskId` as a uuid, so the request 400'd at the Zod boundary and the
 * `'delegated'` write on the other side of it was never even attempted. Two
 * independent bugs on one path: fixing only the CHECK constraint would have
 * left the button just as broken.
 */
describe('useChatAboutActions — dispatch id form', () => {
  const TASK_UUID = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5061';

  function dispatchWith(sourceKind: string, sourceId: string) {
    h.harnesses = [openclaw];

    const context = namedChatContext({
      title: 'Book the dentist',
      body: 'Any Friday morning',
      sourceKind,
      sourceId,
    });

    return renderHook(() => useChatAboutActions(context), { wrapper: MemoryRouter });
  }

  it('decodes the task global id into the raw uuid before posting', async () => {
    const { result } = dispatchWith('Task', btoa(`task:${TASK_UUID}`));

    await result.current.dispatchToOpenClaw();

    await waitFor(() => expect(h.createDispatchJob).toHaveBeenCalled());
    expect(h.createDispatchJob).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({ taskId: TASK_UUID }),
    );
  });

  it('sends no taskId for a memory that is not a task', async () => {
    const { result } = dispatchWith('NoteType', btoa(`note:${TASK_UUID}`));

    await result.current.dispatchToOpenClaw();

    await waitFor(() => expect(h.createDispatchJob).toHaveBeenCalled());
    expect(h.createDispatchJob).toHaveBeenCalledWith('test-token', expect.objectContaining({ taskId: null }));
  });
});
