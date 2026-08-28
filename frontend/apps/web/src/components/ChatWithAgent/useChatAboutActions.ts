import { useCallback, useMemo } from 'react';

import { useNavigate } from 'react-router-dom';

import { useAgentHarnesses, type AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { type AgentChatContext, openAgentHarness, openInAppChat } from '@/lib/agentChat';

/** Harnesses the user can actually open: running, or connected to CI Memory. */
export function isChatableHarness(harness: AgentHarnessStatus): boolean {
  return Boolean(harness.openUrl) && (harness.connectedToMemory || harness.running);
}

export function useChatAboutActions(context: AgentChatContext) {
  const navigate = useNavigate();
  const { harnesses, loading } = useAgentHarnesses();

  const chatableHarnesses = useMemo(() => harnesses.filter(isChatableHarness), [harnesses]);

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

  return { chatableHarnesses, loading, chatHere, openHarness };
}
