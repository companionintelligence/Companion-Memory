/* eslint-disable @typescript-eslint/no-explicit-any */
import { BlueBubblesClientService, type BlueBubblesConfigService } from '@ci/domains/bluebubbles';
import { BlueBubblesApiClient } from '@ci/domains/import';

import { IntentCatalogService } from '../../catalog/IntentCatalogService';
import { NativeToolProvider } from '../../providers/NativeToolProvider';
import { openGate } from '../../registry/__tests__/gateDouble';
import { ToolRegistry } from '../../registry/ToolRegistry';
import { MessagingListChatsTool } from '../MessagingListChatsTool';
import { MessagingListMessagesTool } from '../MessagingListMessagesTool';
import { MessagingSendTool } from '../MessagingSendTool';

/**
 * The `messaging.*` intents act on ONE BlueBubbles connector: one person's Mac, iMessage account
 * and Apple ID. They used to be ordinary native intents with no owner, so every account on the
 * appliance could list the owner's chats, read their messages and send texts as them, over
 * `/api/intents`, MCP and chat alike.
 *
 * Two independent checks, both exercised here with the real classes:
 *  - the registry hides and refuses the three tools for everyone but the connector's owner (the
 *    tools' schemas name that owner, read from the config service on every access);
 *  - `BlueBubblesClientService` refuses anyone but the owner, read from the database row, even
 *    for a caller that reaches the tool without the registry.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const MESSAGING = ['messaging.listChats', 'messaging.listMessages', 'messaging.send'];

const logger: any = new Proxy({}, { get: () => () => undefined });

function configRow(ownerUserId: string | null) {
  return {
    id: 'cfg-1',
    host: 'mac.example.com',
    port: 1234,
    useHttps: false,
    password: 'bb-password',
    enabled: true,
    ownerUserId,
  };
}

/** The config service as the client and the tools see it: the row, and the cached owner. */
function configServiceWith(
  row: { ownerUserId: string | null } | null,
  cachedOwner = row?.ownerUserId ?? null,
) {
  return {
    find: jest.fn(async () => row),
    getOrCreate: jest.fn(async () => row),
    lastKnownOwnerUserId: jest.fn(() => cachedOwner),
  } as unknown as BlueBubblesConfigService & { lastKnownOwnerUserId: jest.Mock };
}

async function build(row: { ownerUserId: string | null } | null, cachedOwner?: string | null) {
  const configService = configServiceWith(row, cachedOwner);
  const client = new BlueBubblesClientService(configService);
  const tools = [
    new MessagingListChatsTool(client, logger),
    new MessagingListMessagesTool(client, logger),
    new MessagingSendTool(client, logger),
  ];
  const registry = new ToolRegistry(logger, { send: jest.fn() } as any, openGate().double);
  await registry.registerProvider(new NativeToolProvider(tools as any, logger));

  return { registry, client, configService, tools, catalog: new IntentCatalogService(registry) };
}

let queryChats: jest.SpyInstance;
let messagesForChat: jest.SpyInstance;
let sendText: jest.SpyInstance;

beforeEach(() => {
  queryChats = jest.spyOn(BlueBubblesApiClient.prototype, 'queryChatsPage').mockResolvedValue([]);
  messagesForChat = jest.spyOn(BlueBubblesApiClient.prototype, 'messagesForChat').mockResolvedValue([]);
  sendText = jest
    .spyOn(BlueBubblesApiClient.prototype, 'sendText')
    .mockResolvedValue({ guid: 'sent-1' } as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const messagingNames = (schemas: Array<{ name: string }>) =>
  schemas.map((s) => s.name).filter((name) => name.startsWith('messaging.'));

describe('messaging intents belong to the BlueBubbles connector owner', () => {
  it('lists them to the owner and to nobody else, in chat, MCP and the intent manifest', async () => {
    const { registry, catalog } = await build(configRow(OWNER));

    expect(messagingNames(registry.getAgentFacingTools({ userId: OWNER })).sort()).toEqual(MESSAGING);
    expect(messagingNames(registry.getAgentFacingTools({ userId: MEMBER }))).toEqual([]);
    expect(messagingNames(catalog.getManifest({ userId: OWNER }).intents).sort()).toEqual(MESSAGING);
    expect(messagingNames(catalog.getManifest({ userId: MEMBER }).intents)).toEqual([]);
    for (const name of ['messaging_listChats', 'messaging_listMessages', 'messaging_send']) {
      expect(registry.isToolVisibleTo(name, OWNER)).toBe(true);
      expect(registry.isToolVisibleTo(name, MEMBER)).toBe(false);
    }
  });

  it.each([
    ['messaging_listChats', {}],
    ['messaging_listMessages', { chatGuid: 'iMessage;-;+15550001111' }],
    ['messaging_send', { chatGuid: 'iMessage;-;+15550001111', message: 'hi' }],
  ])(
    'refuses %s to another account as if it did not exist, and never reaches the Mac',
    async (tool, input) => {
      const { registry } = await build(configRow(OWNER));

      const result = await registry.executeTool(tool, { userId: MEMBER, capability: 'full' }, input);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('TOOL_NOT_FOUND');
      expect(queryChats).not.toHaveBeenCalled();
      expect(messagesForChat).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it('runs them for the owner', async () => {
    const { registry } = await build(configRow(OWNER));

    await expect(
      registry.executeTool('messaging_listChats', { userId: OWNER, capability: 'full' }, { maxResults: 5 }),
    ).resolves.toMatchObject({ success: true });
    await expect(
      registry.executeTool(
        'messaging_send',
        { userId: OWNER, capability: 'full' },
        { chatGuid: 'iMessage;-;+15550001111', message: 'on my way' },
      ),
    ).resolves.toMatchObject({ success: true });

    expect(queryChats).toHaveBeenCalledWith({ limit: 5 });
    expect(sendText).toHaveBeenCalledWith('iMessage;-;+15550001111', 'on my way');
  });

  it('hides them from everyone while the connector has no owner', async () => {
    const { registry } = await build(configRow(null));

    expect(messagingNames(registry.getAgentFacingTools({ userId: OWNER }))).toEqual([]);
    expect(messagingNames(registry.getAgentFacingTools({ userId: MEMBER }))).toEqual([]);
  });

  it('the client refuses a non-owner even when the registry is not in the way', async () => {
    // A stale cached owner (another process changed it) or a caller that reaches the tool
    // directly: the database row decides.
    const { tools } = await build(configRow(OWNER), MEMBER);
    const [listChats, listMessages, send] = tools;

    for (const [tool, input] of [
      [listChats, {}],
      [listMessages, { chatGuid: 'c' }],
      [send, { chatGuid: 'c', message: 'm' }],
    ] as const) {
      const result = await tool.execute({ userId: MEMBER }, input);

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe('BlueBubbles on this Companion is connected to another account.');
    }

    expect(queryChats).not.toHaveBeenCalled();
    expect(messagesForChat).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('the client refuses a call with no user at all, and one when nobody owns the connector', async () => {
    const owned = await build(configRow(OWNER));
    const unowned = await build(configRow(null));

    await expect(owned.client.listChats(undefined)).rejects.toThrow('connected to another account');
    await expect(unowned.client.listChats(OWNER)).rejects.toThrow('BlueBubbles is not set up');
    expect(queryChats).not.toHaveBeenCalled();
  });
});
