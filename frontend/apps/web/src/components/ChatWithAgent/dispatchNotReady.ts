import type { AgentHarnessStatus, DispatchBlocker } from '@/api/useAgentHarnesses';

/** Copy for a Dispatch click when OpenClaw is present but not ready. */
export function dispatchNotReadyMessage(blocker: DispatchBlocker): string {
  switch (blocker) {
    case 'not_installed':
      return 'OpenClaw is not installed on this Hub. Install it, then try Dispatch again.';
    case 'not_connected':
      return 'OpenClaw is not connected to Memory. Connect it in Hub, then try Dispatch again.';
    case 'not_running':
      return 'OpenClaw is not running. Start it in Hub, then try Dispatch again.';
    case 'not_wakeable':
      return 'Hub cannot wake OpenClaw right now. Check the app in Hub, then try again.';
    case 'chat_only':
      return 'This agent is chat-only. Dispatch needs OpenClaw.';
    default:
      return 'OpenClaw is not ready for Dispatch yet.';
  }
}

/** Prefer Connect when Hub can fix the blocker; otherwise plain error copy. */
export function dispatchNotReadyAction(
  openclaw: Pick<AgentHarnessStatus, 'dispatchBlocker' | 'connectUrl'>,
): { label: string; onClick: () => void } | undefined {
  if (
    (openclaw.dispatchBlocker === 'not_installed' || openclaw.dispatchBlocker === 'not_connected') &&
    openclaw.connectUrl
  ) {
    return {
      label: 'Connect in Hub',
      onClick: () => {
        window.open(openclaw.connectUrl!, '_blank', 'noopener,noreferrer');
      },
    };
  }

  return undefined;
}
