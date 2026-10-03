import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { namedChatContext } from '@/lib/agentChat';

import { useChatAboutActions } from './useChatAboutActions';

const h = vi.hoisted(() => ({
  createDispatchJob: vi.fn(async () => ({ threadId: 'thread-1' })),
  harnesses: [] as AgentHarnessStatus[],
  // The web session holds a JWT. The native shell holds only a device API key, so there is no
  // JWT there (`authToken` null) while the session is still `authenticated`.
  auth: { authToken: 'test-token' as string | null, authenticated: true },
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@ci/shadcn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/shadcn')>()),
  useToast: () => ({ toast: h.toast }),
}));

vi.mock('@/api/useAgentHarnesses', () => ({
  useAgentHarnesses: () => ({ harnesses: h.harnesses, loading: false }),
}));

vi.mock('@/api/useDispatchJob', () => ({
  createDispatchJob: h.createDispatchJob,
}));

vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useAuth: () => [h.auth],
}));

beforeEach(() => {
  h.auth.authToken = 'test-token';
  h.auth.authenticated = true;
  h.createDispatchJob.mockClear();
  h.toast.error.mockClear();
  h.toast.success.mockClear();
});

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

/**
 * ═══ "SIGN IN TO DISPATCH" ON A SIGNED-IN PHONE ═══
 *
 * The harness list is now fetched on the phone too, so its menus carry OpenClaw and Dispatch.
 * `dispatchToOpenClaw` refused unless there was a web JWT — which the Capacitor app never has; its
 * durable credential is a keystore API key `fetchJson` attaches as `x-api-key`. `POST
 * /v1/agent/jobs` is `JwtOrApiKeyAuthGuard` with `write` capability, which the device key meets.
 */
describe('useChatAboutActions — dispatch auth', () => {
  function dispatch() {
    h.harnesses = [openclaw];

    const context = namedChatContext({
      title: 'Book the dentist',
      body: 'Any Friday morning',
      sourceKind: 'NoteType',
      sourceId: 'note-1',
    });

    return renderHook(() => useChatAboutActions(context), { wrapper: MemoryRouter });
  }

  it('dispatches on the native shell with no web JWT', async () => {
    h.auth.authToken = null;

    const { result } = dispatch();
    await result.current.dispatchToOpenClaw();

    await waitFor(() => expect(h.createDispatchJob).toHaveBeenCalled());
    expect(h.createDispatchJob).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ title: 'Book the dentist' }),
    );
    expect(h.toast.error).not.toHaveBeenCalled();
  });

  it('still asks a signed-out caller to sign in, and sends nothing', async () => {
    h.auth.authToken = null;
    h.auth.authenticated = false;

    const { result } = dispatch();
    await result.current.dispatchToOpenClaw();

    expect(h.toast.error).toHaveBeenCalledWith('Sign in to Dispatch to OpenClaw.');
    expect(h.createDispatchJob).not.toHaveBeenCalled();
  });
});
