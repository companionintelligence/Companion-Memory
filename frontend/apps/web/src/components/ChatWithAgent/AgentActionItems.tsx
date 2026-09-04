import { Button, ContextMenu, DropdownMenu } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';

import type { AgentHarnessStatus } from '@/api/useAgentHarnesses';
import type { AgentChatContext } from '@/lib/agentChat';

import { dispatchNotReadyMessage } from './dispatchNotReady';
import { useChatAboutActions } from './useChatAboutActions';

const NOT_TALKING = 'OpenClaw is not talking to Memory right now.';

function chatDisabledReason(harness: AgentHarnessStatus): string | null {
  if (harness.id === 'openclaw' && !harness.connectedToMemory) {
    return null;
  }

  if (harness.id === 'openclaw' && harness.connectedToMemory && !harness.running) {
    return NOT_TALKING;
  }

  if (!harness.running || !harness.openUrl) {
    return harness.id === 'openclaw' ? NOT_TALKING : `${harness.name} is not running.`;
  }

  return null;
}

function dispatchHint(harness: AgentHarnessStatus): string | undefined {
  if (harness.dispatchReady) {
    return undefined;
  }

  return dispatchNotReadyMessage(harness.dispatchBlocker);
}

type Surface = 'dropdown' | 'context' | 'sheet';

interface Props {
  context: AgentChatContext;
  surface: Surface;
  onAction?: () => void;
}

export function AgentActionItems({ context, surface, onAction }: Props) {
  const { t } = useTranslation();
  const { harnesses, openclaw, chatHere, openHarness, connectHarness, dispatchToOpenClaw } =
    useChatAboutActions(context);

  const hermes = harnesses.find((harness) => harness.id === 'hermes');

  const run = (action: () => void) => {
    action();
    onAction?.();
  };

  return (
    <>
      <Item surface={surface} onSelect={() => run(chatHere)}>
        {t('CHAT_WITH_AGENT_HERE')}
      </Item>
      {hermes ? (
        <ChatItem
          surface={surface}
          harness={hermes}
          label={t('CHAT_WITH_AGENT_IN', { name: hermes.name })}
          onOpen={() => run(() => openHarness(hermes))}
        />
      ) : null}
      {openclaw ? (
        <ChatItem
          surface={surface}
          harness={openclaw}
          label={t('CHAT_WITH_AGENT_IN', { name: openclaw.name })}
          onOpen={() => run(() => openHarness(openclaw))}
          onConnect={() => run(() => connectHarness(openclaw))}
        />
      ) : null}
      {openclaw ? (
        <Item
          surface={surface}
          title={dispatchHint(openclaw)}
          onSelect={() => {
            // Always clickable: when not ready, dispatchToOpenClaw toasts the
            // blocker (and a Hub Connect action) instead of a silent no-op.
            void dispatchToOpenClaw().then(() => onAction?.());
          }}
        >
          {t('DISPATCH_TO_OPENCLAW')}
        </Item>
      ) : null}
    </>
  );
}

function ChatItem({
  surface,
  harness,
  label,
  onOpen,
  onConnect,
}: {
  surface: Surface;
  harness: AgentHarnessStatus;
  label: string;
  onOpen: () => void;
  onConnect?: () => void;
}) {
  const { t } = useTranslation();

  if (harness.id === 'openclaw' && !harness.connectedToMemory) {
    return (
      <Item surface={surface} onSelect={onConnect} disabled={!harness.connectUrl}>
        {t('CHAT_WITH_AGENT_CONNECT', { name: harness.name })}
      </Item>
    );
  }

  const reason = chatDisabledReason(harness);

  return (
    <Item surface={surface} onSelect={onOpen} disabled={Boolean(reason)} title={reason ?? undefined}>
      {label}
    </Item>
  );
}

function Item({
  surface,
  children,
  onSelect,
  disabled,
  title,
}: {
  surface: Surface;
  children: string;
  onSelect?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  if (surface === 'dropdown') {
    return (
      <DropdownMenu.Item disabled={disabled} title={title} onSelect={onSelect}>
        {children}
      </DropdownMenu.Item>
    );
  }

  if (surface === 'context') {
    return (
      <ContextMenu.Item disabled={disabled} title={title} onSelect={onSelect}>
        {children}
      </ContextMenu.Item>
    );
  }

  return (
    <Button
      variant="ghost"
      className="h-11 justify-start"
      disabled={disabled}
      title={title}
      onClick={onSelect}
    >
      {children}
    </Button>
  );
}
