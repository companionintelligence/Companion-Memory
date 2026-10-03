import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useDeviceLayout } from '@ci/common';
import { ContextMenu, Sheet, cn } from '@ci/shadcn';
import { useTranslation } from 'react-i18next';

import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import type { AgentChatContext } from '@/lib/agentChat';
import { entityToAgentChatContext } from '@/lib/entityToAgentChatContext';
import type { MemoryEntity } from '@/pages/MemoryPage/useEntityService';

import { AgentActionItems } from './AgentActionItems';

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD_PX = 8;

interface ChatAboutProps {
  context: AgentChatContext;
  children: ReactNode;
  className?: string;
}

interface MemoryChatAboutProps {
  entity: MemoryEntity;
  children: ReactNode;
  className?: string;
}

/** Right-click (desktop) or long-press (mobile) to chat about `context`. */
export function ChatAbout({ context, children, className }: ChatAboutProps) {
  const { isMobile } = useDeviceLayout();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (isMobile) {
    return (
      <MobileChatAbout
        context={context}
        className={className}
        sheetOpen={sheetOpen}
        onSheetOpenChange={setSheetOpen}
      >
        {children}
      </MobileChatAbout>
    );
  }

  return (
    <ContextMenu>
      <ContextMenu.Trigger asChild>
        <div className={className}>{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Content className="z-[1100]">
        <ChatAboutContextItems context={context} />
      </ContextMenu.Content>
    </ContextMenu>
  );
}

/** Memory explorer items: convert the entity, then reuse {@link ChatAbout}. */
export function MemoryChatAbout({ entity, children, className }: MemoryChatAboutProps) {
  const fmt = useDateTimeFormat();
  const context = useMemo(() => entityToAgentChatContext(entity, fmt), [entity, fmt]);

  return (
    <ChatAbout context={context} className={className}>
      {children}
    </ChatAbout>
  );
}

/** Controlled sheet used by surfaces that are not DOM (graph canvas, map pins). */
export function ChatAboutSheet({
  context,
  open,
  onOpenChange,
}: {
  context: AgentChatContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <Sheet.Content
        side="bottom"
        className="z-[1100] rounded-t-xl pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <Sheet.Header>
          <Sheet.Title>{t('CHAT_WITH_AGENT_ABOUT', { title: context.title })}</Sheet.Title>
          <Sheet.Description className="sr-only">{t('CHAT_WITH_AGENT_OPEN_MENU')}</Sheet.Description>
        </Sheet.Header>
        {open ? (
          <div className="flex flex-col gap-1 px-4 pb-4">
            <ChatAboutSheetItems context={context} onAction={() => onOpenChange(false)} />
          </div>
        ) : null}
      </Sheet.Content>
    </Sheet>
  );
}

function MobileChatAbout({
  context,
  children,
  className,
  sheetOpen,
  onSheetOpenChange,
}: ChatAboutProps & {
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
}) {
  const longPress = useLongPress(() => onSheetOpenChange(true));

  return (
    <>
      <div
        className={cn('select-none [-webkit-touch-callout:none]', className)}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
        onClickCapture={longPress.onClickCapture}
        onContextMenu={(event) => {
          event.preventDefault();
          onSheetOpenChange(true);
        }}
      >
        {children}
      </div>
      <ChatAboutSheet context={context} open={sheetOpen} onOpenChange={onSheetOpenChange} />
    </>
  );
}

function ChatAboutContextItems({ context }: { context: AgentChatContext }) {
  return <AgentActionItems context={context} surface="context" />;
}

function ChatAboutSheetItems({ context, onAction }: { context: AgentChatContext; onAction: () => void }) {
  return <AgentActionItems context={context} surface="sheet" onAction={onAction} />;
}

function useLongPress(onLongPress: () => void) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.pointerType === 'mouse') {
        return;
      }

      firedRef.current = false;
      startRef.current = { x: event.clientX, y: event.clientY };
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [clearTimer, onLongPress],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      if (!startRef.current) {
        return;
      }

      const dx = event.clientX - startRef.current.x;
      const dy = event.clientY - startRef.current.y;
      if (dx * dx + dy * dy > MOVE_THRESHOLD_PX * MOVE_THRESHOLD_PX) {
        clearTimer();
      }
    },
    [clearTimer],
  );

  const onPointerUp = useCallback(() => {
    clearTimer();
    startRef.current = null;
  }, [clearTimer]);

  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (firedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      firedRef.current = false;
    }
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onClickCapture,
  };
}
