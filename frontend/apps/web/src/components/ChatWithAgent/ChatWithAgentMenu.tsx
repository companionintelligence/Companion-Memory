import { Button, DropdownMenu, IconButton } from '@ci/shadcn';
import { MessagesSquare } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { type AgentChatContext } from '@/lib/agentChat';

import { AgentActionItems } from './AgentActionItems';
import { useChatAboutActions } from './useChatAboutActions';

interface Props {
  context: AgentChatContext;
  size?: 'sm' | 'icon';
  className?: string;
}

export function ChatWithAgentMenu({ context, size = 'icon', className }: Props) {
  const { t } = useTranslation();
  const { chatHere } = useChatAboutActions(context);

  if (size === 'sm') {
    return (
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className={className} onClick={chatHere}>
          <MessagesSquare className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
          {t('CHAT_WITH_AGENT_HERE')}
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenu.Trigger asChild>
            <Button variant="outline" size="sm" className={className}>
              {t('CHAT_WITH_AGENT_OPEN_MENU')}
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" className="z-[1100]">
            <AgentActionItems context={context} surface="dropdown" />
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
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
        <AgentActionItems context={context} surface="dropdown" />
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
