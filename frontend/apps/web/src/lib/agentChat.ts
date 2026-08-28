import type { NavigateFunction } from 'react-router-dom';

import { CHAT_BASE } from '@/pages/ChatPage/chatPaths';

export interface AgentChatContext {
  title: string;
  body?: string | null;
  sourceKind?: string;
  sourceId?: string;
}

/** Build chat-about context from a named record that is not a Memory explorer entity. */
export function namedChatContext(input: {
  title?: string | null;
  body?: string | null;
  sourceKind: string;
  sourceId: string;
}): AgentChatContext {
  const title = input.title?.trim();
  const body = input.body?.trim();

  return {
    title: title && title.length > 0 ? title : 'This memory',
    body: body && body.length > 0 ? body : null,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
  };
}

/** Chat-about seed from a graph overview / focus node. */
export function graphNodeChatContext(node: {
  id: string;
  entity_id?: string;
  entity_type?: string;
  name?: string | null;
  description?: string | null;
  event_type?: string | null;
}): AgentChatContext {
  const facts = [
    node.entity_type ? `Kind: ${node.entity_type.replace(/[_-]+/g, ' ')}` : null,
    node.event_type ? `Event: ${node.event_type.replace(/[_-]+/g, ' ')}` : null,
    node.description?.trim() || null,
  ].filter((line): line is string => Boolean(line));

  return namedChatContext({
    title: node.name,
    body: facts.length > 0 ? facts.join('\n') : null,
    sourceKind: node.entity_type ?? 'GenericEntity',
    sourceId: node.entity_id || node.id,
  });
}

const SESSION_KEY = 'ci.agentChat.seed';

/** Persist context for ChatPage to pick up after navigation. */
export function stashAgentChatContext(context: AgentChatContext): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(context));
}

export function readAgentChatContext(): AgentChatContext | null {
  const raw = sessionStorage.getItem(SESSION_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AgentChatContext;
  } catch {
    return null;
  }
}

export function clearAgentChatContext(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

/** Open Memory's in-app chat with action context pre-filled. */
export function openInAppChat(navigate: NavigateFunction, context: AgentChatContext): void {
  stashAgentChatContext(context);
  navigate(CHAT_BASE);
}

/** Composer seed used by in-app Chat and as the `prompt` query param for harnesses. */
export function formatAgentChatDraft(context: AgentChatContext): string {
  return context.body
    ? `I'd like to talk about "${context.title}":\n\n${context.body}`
    : `I'd like to talk about "${context.title}".`;
}

/** Open a Hub-managed agent harness in a new tab with optional context query params. */
export function openAgentHarness(openUrl: string, context: AgentChatContext): void {
  const url = new URL(openUrl);
  const draft = formatAgentChatDraft(context);

  url.searchParams.set('title', context.title);
  url.searchParams.set('prompt', draft.slice(0, 4000));

  if (context.body) {
    url.searchParams.set('context', context.body.slice(0, 2000));
  }

  if (context.sourceId) {
    url.searchParams.set('memoryId', context.sourceId);
  }

  if (context.sourceKind) {
    url.searchParams.set('memoryKind', context.sourceKind);
  }

  window.open(url.toString(), '_blank', 'noopener,noreferrer');
}

/** @deprecated Use {@link openAgentHarness} with a discovered harness URL. */
export function openAgentApp(app: 'openclaw' | 'hermes', context: AgentChatContext): void {
  const params = new URLSearchParams({
    title: context.title,
    prompt: formatAgentChatDraft(context).slice(0, 4000),
    ...(context.body ? { context: context.body.slice(0, 2000) } : {}),
  });

  const path = app === 'openclaw' ? '/connect/openclaw' : '/connect/hermes';
  window.open(`${path}?${params.toString()}`, '_blank', 'noopener,noreferrer');
}
