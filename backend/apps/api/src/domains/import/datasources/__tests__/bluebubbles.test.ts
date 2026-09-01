import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  attachmentDestination,
  blueBubblesBodyText,
  BlueBubblesAPIImporter,
  downloadAttachments,
  mapBlueBubblesMessageToGraph,
} from '../bluebubbles';
import { BlueBubblesApiClient, type BlueBubblesChat, type BlueBubblesMessage } from '../bluebubblesApiClient';
import type { Graph, ImportParams, Relationship } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const SETTINGS = {
  getSetting: (key: string) =>
    ({ host: 'mac.local', port: '1234', password: 'hunter2' })[key] as string | undefined,
};

function collector(): { pipeline: EmittedGraph[]; params: ImportParams } {
  const pipeline: EmittedGraph[] = [];

  return {
    pipeline,
    params: {
      pipeline: { push: (g: Graph) => pipeline.push(g as EmittedGraph) },
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams,
  };
}

function message(overrides: Partial<BlueBubblesMessage> = {}): BlueBubblesMessage {
  return { guid: 'msg-1', dateCreated: 1_700_000_000_000, text: 'hello', isFromMe: false, ...overrides };
}

/** A typedstream `attributedBody` blob carrying `text`, as chat.db stores one. */
function typedStream(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');

  return Buffer.concat([
    Buffer.from('streamtyped', 'ascii'),
    Buffer.from('NSString', 'ascii'),
    Buffer.from([0x2b, body.length]),
    body,
  ]);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('mapBlueBubblesMessageToGraph', () => {
  it('reads the body out of attributedBody when text is NULL', () => {
    // 42,170 of 433,398 live messages (9.7%) have text IS NULL: recent macOS
    // writes the body only into attributedBody.
    const graph = mapBlueBubblesMessageToGraph(
      message({ text: null, attributedBody: [{ string: 'sent from a 2026 Mac' }] }),
      undefined,
    );

    expect(graph.item?.metadata?.Text).toBe('sent from a 2026 Mac');
  });

  it('decodes a raw typedstream attributedBody, base64 or JSON Buffer', () => {
    expect(blueBubblesBodyText(message({ text: null, attributedBody: typedStream('base64 body').toString('base64') }))).toBe(
      'base64 body',
    );
    expect(
      blueBubblesBodyText(
        message({
          text: null,
          attributedBody: { type: 'Buffer', data: [...typedStream('buffer body')] },
        }),
      ),
    ).toBe('buffer body');
  });

  it('prefers text over attributedBody, and yields nothing when neither is usable', () => {
    expect(blueBubblesBodyText(message({ text: 'plain', attributedBody: [{ string: 'other' }] }))).toBe('plain');
    expect(blueBubblesBodyText(message({ text: null, attributedBody: null }))).toBeUndefined();
    expect(blueBubblesBodyText(message({ text: null, attributedBody: { nonsense: true } }))).toBeUndefined();
  });

  it('does not stage the body of a retracted message, but keeps the row', () => {
    const graph = mapBlueBubblesMessageToGraph(
      message({ text: 'unsent this', dateRetracted: 1_700_000_100_000 }),
      undefined,
    );

    expect(graph.item?.metadata?.Text).toBeUndefined();
    expect(graph.item?.metadata?.RetractedAt).toBe(new Date(1_700_000_100_000).toISOString());
    expect(graph.item?.id).toBe('msg-1');
  });

  it('records an edit timestamp so the current wording is not read as the original', () => {
    const graph = mapBlueBubblesMessageToGraph(message({ dateEdited: 1_700_000_050_000 }), undefined);

    expect(graph.item?.metadata?.EditedAt).toBe(new Date(1_700_000_050_000).toISOString());
  });

  it('passes the service through and never invents one', () => {
    expect(mapBlueBubblesMessageToGraph(message({ service: 'SMS' }), undefined).item?.metadata?.Service).toBe(
      'SMS',
    );
    // Was hardcoded to 'iMessage', which mislabels every SMS whose row omits it.
    expect(
      mapBlueBubblesMessageToGraph(message({ service: null }), undefined).item?.metadata?.Service,
    ).toBeUndefined();
  });

  it('threads on chat_identifier, not the BlueBubbles chat guid', () => {
    // imessage.ts keys on chat_identifier; keying on the guid fragments the same
    // conversation into two threads when it is imported both ways.
    const chat: BlueBubblesChat = {
      guid: 'iMessage;-;+15551234567',
      chatIdentifier: '+15551234567',
      style: 45,
      participants: [{ address: '+15551234567' }],
    };

    const graph = mapBlueBubblesMessageToGraph(message(), chat);

    expect(graph.item?.metadata?.ThreadId).toBe('+15551234567');
    expect(graph.item?.metadata?.ChatId).toBe('+15551234567');
  });

  it('falls back to a known 1:1 chat identifier when the message has no chat', () => {
    const withEvidence = mapBlueBubblesMessageToGraph(
      message({ handle: { address: '+15551234567' } }),
      undefined,
      { oneToOneChatIdentifiers: new Set(['+15551234567']) },
    );
    // No evidence that this handle is a 1:1 chat: the message might equally be
    // an orphaned group message, so nothing is invented.
    const withoutEvidence = mapBlueBubblesMessageToGraph(
      message({ handle: { address: '+15551234567' } }),
      undefined,
      { oneToOneChatIdentifiers: new Set() },
    );

    expect(withEvidence.item?.metadata?.ThreadId).toBe('+15551234567');
    expect(withoutEvidence.item?.metadata?.ThreadId).toBeUndefined();
  });

  it('gives an outbound message participant edges from its own handle when the chat lists none', () => {
    // The bug imessage.ts documents fixing (16,325 affected messages): edges
    // built from chat participants alone leave every message the owner sent
    // pointing at nobody whenever the chat came back without a participant list.
    const graph = mapBlueBubblesMessageToGraph(
      message({ isFromMe: true, handle: { address: '+15559998888' } }),
      { guid: 'iMessage;-;+15559998888', chatIdentifier: '+15559998888', style: 45, participants: [] },
    );

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges![0]).toMatchObject({
      relation: 'participant',
      metadata: { direction: 'outgoing' },
    });
    expect(graph.edges![0].to?.entity?.name).toBe('+15559998888');
  });

  it('unions the chat participants with the row handle without duplicating one', () => {
    const graph = mapBlueBubblesMessageToGraph(message({ isFromMe: true, handle: { address: '+1555000' } }), {
      guid: 'iMessage;+;chat1',
      chatIdentifier: 'chat1',
      style: 43,
      participants: [{ address: '+1555000' }, { address: '+1555111' }],
    });

    expect(graph.edges!.map((edge: Relationship) => edge.to?.entity?.name)).toEqual(['+1555000', '+1555111']);
  });

  it('still points an inbound message at its sender alone', () => {
    const graph = mapBlueBubblesMessageToGraph(message({ handle: { address: '+1555222' } }), {
      guid: 'iMessage;+;chat1',
      chatIdentifier: 'chat1',
      style: 43,
      participants: [{ address: '+1555222' }, { address: '+1555333' }],
    });

    // resolveCorrespondents reads the first participant edge as the sender.
    expect(graph.edges!.map((edge: Relationship) => edge.to?.entity?.name)).toEqual(['+1555222']);
  });
});

describe('attachmentDestination', () => {
  it('keeps a traversing guid inside the media store', () => {
    // The guid is the DIRECTORY component and was interpolated raw, so a
    // hostile or MITM'd server could name any path on the appliance. use_https
    // defaults to false, so plain HTTP over a LAN is the expected deployment.
    const dest = attachmentDestination('/srv/scratch', '../../../../home/node/.ssh', 'authorized_keys');

    expect(dest).not.toBeNull();
    expect(dest!.startsWith(`${path.resolve('/srv/scratch')}${path.sep}`)).toBe(true);
    expect(dest).not.toContain('..');
  });

  it('refuses a guid that is nothing but a traversal segment', () => {
    for (const guid of ['..', '.', '../..']) {
      const dest = attachmentDestination('/srv/scratch', guid, 'x.jpg');

      expect(dest).not.toBeNull();
      expect(path.relative('/srv/scratch', dest!).startsWith('..')).toBe(false);
    }
  });

  it('writes attachment bytes under the media store even for a hostile guid', async () => {
    const store = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bb-att-'));
    const outside = path.join(store, '..', 'escaped-marker');
    const msg = message({
      attachments: [{ guid: '../../escaped-marker', transferName: 'photo.jpg', mimeType: 'image/jpeg' }],
    });
    const graph = mapBlueBubblesMessageToGraph(msg, undefined);
    const client = {
      downloadAttachment: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
    } as unknown as BlueBubblesApiClient;

    await downloadAttachments(graph, msg, client, store);

    const descriptor = (graph.item!.metadata!.MediaAttachments as Array<{ path?: string }>)[0];

    expect(descriptor.path).toBeDefined();
    expect(descriptor.path!.startsWith(`${path.resolve(store)}${path.sep}`)).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
    expect(fs.readFileSync(descriptor.path!, 'utf8')).toBe('jpeg-bytes');
  });
});

describe('BlueBubblesAPIImporter.apiImport', () => {
  it('rejects when a message page fetch fails, rather than resolving as a clean pass', async () => {
    // The live DB held 167 runs marked `completed` with connectionStatus
    // 'connected' and lastError NULL — one of them over a 401 — because a failed
    // page fetch logged and `break`ed, so apiImport resolved normally.
    jest.spyOn(BlueBubblesApiClient.prototype, 'queryChats').mockResolvedValue([]);
    jest
      .spyOn(BlueBubblesApiClient.prototype, 'queryMessages')
      .mockRejectedValue(new Error('BlueBubbles request failed: 401 Unauthorized'));

    const { params } = collector();

    await expect(new BlueBubblesAPIImporter().apiImport(SETTINGS, params)).rejects.toThrow('401');
  });

  /**
   * The caller advances a RATCHETING sync cursor to MAX(occurred_at) over what
   * a pass staged, including a pass that died part-way. That is only safe while
   * the staged rows are a contiguous ascending prefix — otherwise the max sits
   * beyond messages that were never fetched, and they are skipped permanently
   * and silently. `sort: 'ASC'` is requested but not guaranteed, so the pass
   * stops at the first violation and keeps whatever it already staged.
   */
  it('stops the pass when the server answers out of order, keeping the staged rows a prefix', async () => {
    jest.spyOn(BlueBubblesApiClient.prototype, 'queryChats').mockResolvedValue([]);
    jest
      .spyOn(BlueBubblesApiClient.prototype, 'queryMessages')
      .mockResolvedValue([
        message({ guid: 'a', dateCreated: 1_700_000_000_000 }),
        message({ guid: 'b', dateCreated: 1_700_000_005_000 }),
        // Older than the one before it — the ordering contract broken.
        message({ guid: 'c', dateCreated: 1_700_000_001_000 }),
        message({ guid: 'd', dateCreated: 1_700_000_009_000 }),
      ]);

    const { pipeline, params } = collector();

    await expect(new BlueBubblesAPIImporter().apiImport(SETTINGS, params)).rejects.toThrow(
      /out of order/,
    );

    // Everything before the violation is kept and is still a prefix; nothing at
    // or after it is staged, so the cursor cannot be advanced past 'c'.
    expect(pipeline).toHaveLength(2);
    expect(pipeline.map((g) => g.item.id)).toEqual(['a', 'b']);
  });

  it('accepts equal adjacent timestamps, which a real burst produces constantly', async () => {
    // Ascending is not STRICTLY ascending: chat.db routinely holds runs of
    // messages sharing one timestamp, and rejecting those would fail every
    // real pass.
    jest.spyOn(BlueBubblesApiClient.prototype, 'queryChats').mockResolvedValue([]);
    jest
      .spyOn(BlueBubblesApiClient.prototype, 'queryMessages')
      .mockResolvedValueOnce([
        message({ guid: 'a', dateCreated: 1_700_000_000_000 }),
        message({ guid: 'b', dateCreated: 1_700_000_000_000 }),
        message({ guid: 'c', dateCreated: 1_700_000_000_000 }),
      ])
      .mockResolvedValue([]);

    const { pipeline, params } = collector();

    await expect(new BlueBubblesAPIImporter().apiImport(SETTINGS, params)).resolves.toBeUndefined();
    expect(pipeline).toHaveLength(3);
  });

  it('resolves over an empty server, so "nothing new" stays distinguishable from "rejected"', async () => {
    jest.spyOn(BlueBubblesApiClient.prototype, 'queryChats').mockResolvedValue([]);
    jest.spyOn(BlueBubblesApiClient.prototype, 'queryMessages').mockResolvedValue([]);

    const { pipeline, params } = collector();

    await expect(new BlueBubblesAPIImporter().apiImport(SETTINGS, params)).resolves.toBeUndefined();
    expect(pipeline).toHaveLength(0);
  });

  it('retries the chat directory and then fails the pass rather than importing nobody', async () => {
    // An empty directory is not a degraded mode: every message loses its
    // participants, ChatId, ThreadId and GroupName, and outbound messages lose
    // their participant edges entirely.
    jest.useFakeTimers();

    const queryChats = jest
      .spyOn(BlueBubblesApiClient.prototype, 'queryChats')
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const queryMessages = jest.spyOn(BlueBubblesApiClient.prototype, 'queryMessages').mockResolvedValue([]);
    const { params } = collector();

    const settled = expect(new BlueBubblesAPIImporter().apiImport(SETTINGS, params)).rejects.toThrow(
      /chat directory/,
    );

    await jest.advanceTimersByTimeAsync(30_000);
    await settled;

    expect(queryChats).toHaveBeenCalledTimes(3);
    expect(queryMessages).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it('advances past a full page that does not move the cursor instead of re-requesting it forever', async () => {
    // BlueBubbles applies `date >= after`, so a page whose rows all share the
    // cursor's timestamp leaves the cursor where it was — and without the offset
    // guard the loop re-issues a byte-identical request forever.
    jest.spyOn(BlueBubblesApiClient.prototype, 'queryChats').mockResolvedValue([]);

    const stuck = Array.from({ length: 1000 }, (_, i) => message({ guid: `g-${i}`, dateCreated: 1_000 }));
    const offsets: number[] = [];
    const queryMessages = jest
      .spyOn(BlueBubblesApiClient.prototype, 'queryMessages')
      .mockImplementation(async ({ offset }) => {
        offsets.push(offset ?? 0);

        if (offsets.length > 5) {
          throw new Error('paging loop failed to make progress');
        }

        return (offset ?? 0) >= 1000 ? [] : stuck;
      });

    const { pipeline, params } = collector();

    await new BlueBubblesAPIImporter().apiImport(SETTINGS, params);

    expect(queryMessages.mock.calls.length).toBeLessThanOrEqual(5);
    expect(offsets).toContain(1000);
    expect(pipeline.length).toBeGreaterThan(0);
  });

  it('supplies the 1:1 chat identifiers it learned from the directory', async () => {
    jest.spyOn(BlueBubblesApiClient.prototype, 'queryChats').mockResolvedValue([
      {
        guid: 'iMessage;-;+15551234567',
        chatIdentifier: '+15551234567',
        style: 45,
        participants: [{ address: '+15551234567' }],
      },
    ]);
    jest
      .spyOn(BlueBubblesApiClient.prototype, 'queryMessages')
      .mockResolvedValueOnce([message({ handle: { address: '+15551234567' } })])
      .mockResolvedValue([]);

    const { pipeline, params } = collector();

    await new BlueBubblesAPIImporter().apiImport(SETTINGS, params);

    expect(pipeline[0].item.metadata.ThreadId).toBe('+15551234567');
  });

  it('refuses to run without credentials instead of reporting an empty success', async () => {
    await expect(
      new BlueBubblesAPIImporter().apiImport({ getSetting: () => undefined }, collector().params),
    ).rejects.toThrow(/configured/);
  });
});
