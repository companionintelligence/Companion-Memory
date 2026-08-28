import { Button, DropdownMenu, IconButton } from '@ci/shadcn';
import { ExternalLink, MessagesSquare } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { type AgentChatContext, openAgentHarness } from '@/lib/agentChat';

import { useChatAboutActions } from './useChatAboutActions';

interface Props {
  context: AgentChatContext;
  size?: 'sm' | 'icon';
  className?: string;
}

export function ChatWithAgentMenu({ context, size = 'icon', className }: Props) {
  const { t } = useTranslation();
  const { chatableHarnesses, loading, chatHere } = useChatAboutActions(context);

  if (size === 'sm') {
    return (
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className={className} onClick={chatHere}>
          <MessagesSquare className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
          {t('CHAT_WITH_AGENT_HERE')}
        </Button>
        {!loading &&
          chatableHarnesses.map((harness) => (
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
      </div>
    );
  }

  const hasHarnesses = !loading && chatableHarnesses.length > 0;

  if (!hasHarnesses) {
    return (
      <IconButton
        variant="ghost"
        className={className}
        label={t('CHAT_WITH_AGENT_ABOUT', { title: context.title })}
        onClick={chatHere}
      >
        <MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
      </IconButton>
    );
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenu.Trigger asChild>
        <IconButton
          variant="ghost"
          className={className}
          label={t('CHAT_WITH_AGENT_ABOUT', { title: context.title })}
          tooltip={t('CHAT_WITH_AGENT_OPEN_MENU')}
        >
          <MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.5} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" className="z-[1100]">
        <DropdownMenu.Item onClick={chatHere}>{t('CHAT_WITH_AGENT_HERE')}</DropdownMenu.Item>
        {chatableHarnesses.map((harness) => (
          <DropdownMenu.Item key={harness.id} onClick={() => openAgentHarness(harness.openUrl!, context)}>
            {t('CHAT_WITH_AGENT_OPEN_IN', { name: harness.name })}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
