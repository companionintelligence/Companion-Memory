import { useCallback, useMemo } from 'react';

import { useToast } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { useAgentHarnesses, type AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { createDispatchJob } from '@/api/useDispatchJob';
import { useAuth } from '@/hooks';
import {
  type AgentChatContext,
  openAgentHarness,
  openInAppChat,
  taskUuidFromGlobalId,
} from '@/lib/agentChat';
import { chatThreadPath } from '@/pages/ChatPage/chatPaths';

import { dispatchNotReadyAction, dispatchNotReadyMessage } from './dispatchNotReady';

/** Chat: running + open URL. OpenClaw also has to be talking to Memory. */
export function isChatableHarness(harness: AgentHarnessStatus): boolean {
  if (!harness.openUrl || !harness.running) {
    return false;
  }

  return harness.id === 'openclaw' ? harness.connectedToMemory : true;
}

/** Hub has the app: Portal lists it, or Hub already minted it a connect key. */
function isInstalledHarness(harness: AgentHarnessStatus): boolean {
  return harness.installed || harness.connectedToMemory;
}

export function useChatAboutActions(context: AgentChatContext) {
  const navigate = useNavigate();
  const { toast } = useToast();
  // `authenticated`, not `authToken`: the token is the web JWT, which the native shell never has —
  // its credential is a keystore API key, and `POST /v1/agent/jobs` takes it.
  const [{ authToken, authenticated }] = useAuth();
  const { harnesses, loading } = useAgentHarnesses();

  const installedHarnesses = useMemo(() => harnesses.filter(isInstalledHarness), [harnesses]);
  const chatableHarnesses = useMemo(() => installedHarnesses.filter(isChatableHarness), [installedHarnesses]);
  // Take OpenClaw from the full list. The API returns it even when it is not
  // installed, so on a Hub the menu can offer Connect. Dispatch then toasts why
  // it is not ready instead of vanishing. With no Hub to install it from (no
  // `connectUrl`, as on Memory Desktop) neither row can ever work, so leave it out.
  const openclaw = useMemo(() => {
    const found = harnesses.find((harness) => harness.id === 'openclaw');

    return found && (isInstalledHarness(found) || found.connectUrl) ? found : null;
  }, [harnesses]);

  const chatHere = useCallback(() => {
    openInAppChat(navigate, context);
  }, [navigate, context]);

  const openHarness = useCallback(
    (harness: AgentHarnessStatus) => {
      if (harness.openUrl) {
        openAgentHarness(harness.openUrl, context);
      }
    },
    [context],
  );

  const connectHarness = useCallback((harness: AgentHarnessStatus) => {
    if (harness.connectUrl) {
      window.open(harness.connectUrl, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const dispatchToOpenClaw = useCallback(async () => {
    if (!authenticated) {
      toast.error('Sign in to Dispatch to OpenClaw.');

      return;
    }

    if (!openclaw) {
      // Null when there is no Hub to install it from, or the list has not loaded, so name no Hub.
      toast.error('OpenClaw is not available on this Memory.');

      return;
    }

    if (!openclaw.dispatchReady) {
      const action = dispatchNotReadyAction(openclaw);
      toast.error(dispatchNotReadyMessage(openclaw.dispatchBlocker), action ? { action } : undefined);

      return;
    }

    try {
      const sourceKind = context.sourceKind ?? 'GenericEntity';
      const sourceId = context.sourceId ?? context.title;
      const job = await createDispatchJob(authToken ?? null, {
        sourceKind,
        sourceId,
        title: context.title,
        body: context.body,
        // `/v1` is a uuid-in, uuid-out plane; `sourceId` is the GraphQL global
        // id the card was rendered from. Decode, and send nothing rather than
        // something the controller has to reject.
        taskId: sourceKind === 'Task' ? taskUuidFromGlobalId(sourceId) : null,
      });

      toast.success('Handed to OpenClaw. It writes back into the thread when it has something.', {
        action: {
          label: 'Open thread',
          onClick: () => navigate(chatThreadPath(job.threadId)),
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Dispatch did not start.');
    }
  }, [authToken, authenticated, context, navigate, openclaw, toast]);

  return {
    harnesses: installedHarnesses,
    chatableHarnesses,
    openclaw,
    loading,
    chatHere,
    openHarness,
    connectHarness,
    dispatchToOpenClaw,
  };
}
