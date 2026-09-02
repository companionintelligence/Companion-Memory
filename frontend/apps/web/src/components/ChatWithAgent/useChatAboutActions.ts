import { useCallback, useMemo } from 'react';

import { useToast } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { useAgentHarnesses, type AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { createDispatchJob } from '@/api/useDispatchJob';
import { useAuth } from '@/hooks';
import { type AgentChatContext, openAgentHarness, openInAppChat } from '@/lib/agentChat';
import { chatThreadPath } from '@/pages/ChatPage/chatPaths';

/** Chat: running + open URL. OpenClaw also has to be talking to Memory. */
export function isChatableHarness(harness: AgentHarnessStatus): boolean {
  if (!harness.openUrl || !harness.running) {
    return false;
  }

  return harness.id === 'openclaw' ? harness.connectedToMemory : true;
}

export function useChatAboutActions(context: AgentChatContext) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [{ authToken }] = useAuth();
  const { harnesses, loading } = useAgentHarnesses();

  const installedHarnesses = useMemo(
    () => harnesses.filter((harness) => harness.installed || harness.connectedToMemory),
    [harnesses],
  );
  const chatableHarnesses = useMemo(
    () => installedHarnesses.filter(isChatableHarness),
    [installedHarnesses],
  );
  const openclaw = useMemo(
    () => installedHarnesses.find((harness) => harness.id === 'openclaw') ?? null,
    [installedHarnesses],
  );

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
    if (!authToken || !openclaw?.dispatchReady) {
      return;
    }

    try {
      const job = await createDispatchJob(authToken, {
        sourceKind: context.sourceKind ?? 'GenericEntity',
        sourceId: context.sourceId ?? context.title,
        title: context.title,
        body: context.body,
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
  }, [authToken, context, navigate, openclaw, toast]);

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
