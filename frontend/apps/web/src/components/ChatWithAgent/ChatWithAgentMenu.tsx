import { Button, DropdownMenu } from '@ci/shadcn';
import { ExternalLink, MessagesSquare } from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

import { useAgentHarnesses, type AgentHarnessStatus } from '@/api/useAgentHarnesses';
import { type AgentChatContext, openAgentHarness, openInAppChat } from '@/lib/agentChat';

interface Props {
  context: AgentChatContext;
  size?: 'sm' | 'icon';
  className?: string;
}

function RunningHarnessButtons({
  harnesses,
  context,
  className,
}: {
  harnesses: AgentHarnessStatus[];
  context: AgentChatContext;
  className?: string;
}) {
  return (
    <>
      {harnesses.map((harness) => (
        <Button
          key={harness.id}
          variant="outline"
          size="sm"
          className={className}
          onClick={() => openAgentHarness(harness.openUrl!, context)}
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
          {harness.name}
        </Button>
      ))}
    </>
  );
}

export function ChatWithAgentMenu({ context, size = 'icon', className }: Props) {
  const navigate = useNavigate();
  const { runningHarnesses, loading } = useAgentHarnesses();

  if (size === 'sm') {
    return (
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className={className}
          onClick={() => openInAppChat(navigate, context)}
        >
          <MessagesSquare className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
          Chat here
        </Button>
        {!loading && runningHarnesses.length > 0 ? (
          <RunningHarnessButtons harnesses={runningHarnesses} context={context} className={className} />
        ) : null}
      </div>
    );
  }

  const hasRunningHarnesses = !loading && runningHarnesses.length > 0;

  if (!hasRunningHarnesses) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className={className}
        aria-label={`Chat about ${context.title}`}
        onClick={() => openInAppChat(navigate, context)}
      >
        <MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
      </Button>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className={className} aria-label={`Chat about ${context.title}`}>
          <MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item onClick={() => openInAppChat(navigate, context)}>Chat here</DropdownMenu.Item>
        {runningHarnesses.map((harness) => (
          <DropdownMenu.Item key={harness.id} onClick={() => openAgentHarness(harness.openUrl!, context)}>
            Open in {harness.name}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
