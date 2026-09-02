import { useCallback, useMemo } from 'react';

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
  const [{ authToken }] = useAuth();
  const { harnesses, loading } = useAgentHarnesses();

  const installedHarnesses = useMemo(
    () => harnesses.filter((harness) => harness.installed),
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

    const job = await createDispatchJob(authToken, {
      sourceKind: context.sourceKind ?? 'GenericEntity',
      sourceId: context.sourceId ?? context.title,
      title: context.title,
      body: context.body,
    });

    navigate(chatThreadPath(job.threadId));
  }, [authToken, context, navigate, openclaw]);

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
