import { describe, expect, it, vi } from 'vitest';

import {
  formatAgentChatDraft,
  graphNodeChatContext,
  namedChatContext,
  openAgentHarness,
  openInAppChat,
  stashAgentChatContext,
  readAgentChatContext,
  clearAgentChatContext,
  taskUuidFromGlobalId,
  type AgentChatContext,
} from './agentChat';

describe('taskUuidFromGlobalId', () => {
  const TASK_UUID = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5061';

  it('unwraps a task global id to the raw uuid /v1 wants', () => {
    expect(taskUuidFromGlobalId(btoa(`task:${TASK_UUID}`))).toBe(TASK_UUID);
  });

  it('refuses another entity type, so a Note id never becomes a taskId', () => {
    expect(taskUuidFromGlobalId(btoa(`note:${TASK_UUID}`))).toBeNull();
  });

  it("refuses sourceId's title fallback and anything else undecodable", () => {
    expect(taskUuidFromGlobalId('Book the dentist')).toBeNull();
    expect(taskUuidFromGlobalId(btoa('task:not-a-uuid'))).toBeNull();
    expect(taskUuidFromGlobalId(TASK_UUID)).toBeNull();
    expect(taskUuidFromGlobalId(null)).toBeNull();
    expect(taskUuidFromGlobalId(undefined)).toBeNull();
  });
});

describe('namedChatContext', () => {
  it('trims fields and falls back when the title is blank', () => {
    expect(
      namedChatContext({
        title: '  Sam  ',
        body: '  friend  ',
        sourceKind: 'PersonType',
        sourceId: 'p1',
      }),
    ).toEqual({
      title: 'Sam',
      body: 'friend',
      sourceKind: 'PersonType',
      sourceId: 'p1',
    });

    expect(namedChatContext({ title: '   ', sourceKind: 'PlaceType', sourceId: 'pl1' })).toEqual({
      title: 'This memory',
      body: null,
      sourceKind: 'PlaceType',
      sourceId: 'pl1',
    });
  });
});

describe('graphNodeChatContext', () => {
  it('packs kind, event, and description', () => {
    expect(
      graphNodeChatContext({
        id: 'n1',
        entity_id: 'e1',
        entity_type: 'event',
        name: 'Dinner',
        description: 'Tacos',
        event_type: 'visited',
      }),
    ).toEqual({
      title: 'Dinner',
      body: 'Kind: event\nEvent: visited\nTacos',
      sourceKind: 'event',
      sourceId: 'e1',
    });
  });
});

describe('formatAgentChatDraft', () => {
  it('includes the title and body when both are present', () => {
    expect(formatAgentChatDraft({ title: 'Picnic', body: 'Bring snacks' })).toBe(
      'I\'d like to talk about "Picnic":\n\nBring snacks',
    );
  });

  it('falls back to the title alone', () => {
    expect(formatAgentChatDraft({ title: 'Picnic' })).toBe('I\'d like to talk about "Picnic".');
  });
});

describe('openAgentHarness', () => {
  it('opens the harness URL with prompt, context, and memory ids', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const context: AgentChatContext = {
      title: 'Picnic',
      body: 'Bring snacks',
      sourceKind: 'NoteType',
      sourceId: 'note-1',
    };

    openAgentHarness('https://openclaw.example/chat', context);

    const opened = new URL(String(open.mock.calls[0]?.[0]));
    expect(opened.origin + opened.pathname).toBe('https://openclaw.example/chat');
    expect(opened.searchParams.get('title')).toBe('Picnic');
    expect(opened.searchParams.get('prompt')).toBe('I\'d like to talk about "Picnic":\n\nBring snacks');
    expect(opened.searchParams.get('context')).toBe('Bring snacks');
    expect(opened.searchParams.get('memoryKind')).toBe('NoteType');
    expect(opened.searchParams.get('memoryId')).toBe('note-1');
    expect(open.mock.calls[0]?.[1]).toBe('_blank');

    open.mockRestore();
  });
});

describe('openInAppChat', () => {
  // Chat lives under Memory now (/memory/chat) — this used to hardcode /chat.
  it('stashes the context and navigates to the Memory chat route', () => {
    const navigate = vi.fn();

    openInAppChat(navigate, { title: 'Picnic', body: 'Bring snacks' });

    expect(readAgentChatContext()).toEqual({ title: 'Picnic', body: 'Bring snacks' });
    expect(navigate).toHaveBeenCalledWith('/memory/chat');

    clearAgentChatContext();
  });
});

describe('agent chat session seed', () => {
  it('round-trips context through sessionStorage', () => {
    stashAgentChatContext({ title: 'Picnic', body: 'Bring snacks', sourceKind: 'NoteType' });
    expect(readAgentChatContext()).toEqual({
      title: 'Picnic',
      body: 'Bring snacks',
      sourceKind: 'NoteType',
    });
    clearAgentChatContext();
    expect(readAgentChatContext()).toBeNull();
  });
});
