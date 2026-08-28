import type { CreateCommunicationDto, CreateContentDto } from '@ci/domains/memory';

import type { StagedItem } from '../../entities/StagedItemEntity';
import type { StageRunContext } from '../../types';
import { PushStage } from '../PushStage';

/**
 * Which mapper a communication actually reaches.
 *
 * `push/inputs.ts` has carried WhatsApp- and Messenger-specific mappers since
 * the port, and nothing called them: every communication went through the
 * generic `toCommunicationInput`. Neither export carries an is-from-me signal,
 * so `directionFor` found nothing and the generic default stood — a real
 * corpus pushed 4,205 WhatsApp rows all marked `inbound`, 437 of which the
 * owner had sent — and WhatsApp's thread name, which the importer stamps onto
 * `Conversation`, was read by nobody, so every message lost its chat grouping.
 *
 * These assertions are about the ROUTING, so they drive the real
 * `PushStage.run()` rather than the mappers directly: calling a mapper in a
 * test proves it works, which was never in doubt, and says nothing about
 * whether the stage calls it.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const STAGE_ID = '22222222-2222-4222-8222-222222222222';

/** The account row + self Person row `resolveIsSelf` reads, for an owner named Liam Broza. */
const OWNER_ROWS = [
  { name: 'Liam Broza', email: 'liam.broza@example.com', phones_json: null },
  { name: 'Liam Broza', email: null, phones_json: [] },
];

let nextId = 0;

function stagedRow(over: Partial<StagedItem> = {}): StagedItem {
  nextId += 1;

  return {
    id: `44444444-4444-4444-8444-4444444444${String(nextId).padStart(2, '0')}`,
    runId: RUN_ID,
    userId: USER_ID,
    dataSource: 'whatsapp',
    classification: 'message',
    contentHash: `hash-${nextId}`,
    occurredAt: new Date('2024-05-01T12:00:00Z'),
    timespanEnd: null,
    latitude: null,
    longitude: null,
    filename: null,
    mediaType: null,
    originalLocation: null,
    intermediateLocation: null,
    metadata: {},
    createdAt: new Date('2026-08-12T00:00:00Z'),
    ...over,
  } as StagedItem;
}

function whatsAppRow(sender: string, text: string): StagedItem {
  return stagedRow({
    dataSource: 'whatsapp',
    metadata: { Sender: sender, Conversation: 'Family', Source: 'WhatsApp', Text: text },
  });
}

function messengerRow(sender: string, text: string): StagedItem {
  return stagedRow({
    dataSource: 'facebook',
    metadata: { Sender: sender, To: 'Alice Example', Conversation: 'Alice Example', Text: text },
  });
}

interface Harness {
  stage: PushStage;
  /** Every CreateCommunicationDto the stage handed CommunicationService, in order. */
  sent: CreateCommunicationDto[];
  /** Every CreateContentDto the stage handed ContentService, in order. */
  contentSent: CreateContentDto[];
  warnings: Array<[string, unknown]>;
}

/**
 * A PushStage over a stubbed database, serving exactly the queries `run()`
 * issues. Entity resolution is empty, so `participants` is supplied directly as
 * the edges `participantsFor` would have joined.
 */
function makeStage(
  rows: StagedItem[],
  options: {
    ownerRows?: Array<{ name: string | null; email: string | null }>;
    ownerQueryThrows?: boolean;
    participants?: Array<{ relation: string; server_entity_id: string }>;
    /** Fail the FIRST batched communications write, to exercise the row-by-row retry. */
    failFirstCommunicationBatch?: boolean;
    /** Return one fewer content result than inputs, to exercise the alignment check. */
    shortContentResults?: boolean;
  } = {},
): Harness {
  let servedBatch = false;
  let communicationBatches = 0;
  let nextContentId = 0;
  const sent: CreateCommunicationDto[] = [];
  const contentSent: CreateContentDto[] = [];
  const warnings: Array<[string, unknown]> = [];

  const dataSource = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_database_size')) {
        return [{ bytes: '1000' }];
      }

      // Unreadable data directory → freeBytes null → the floor check abstains.
      if (sql.includes('data_directory')) {
        return [];
      }

      if (sql.trimStart().startsWith('UPDATE')) {
        return [];
      }

      if (sql.includes('staged_relationships')) {
        // The edge lookup is asked for a whole batch at once, so the stub
        // answers per requested id — the fixture means "these edges belong to
        // each row", which is what it meant when the query was one row at a
        // time.
        const ids = (params?.[0] as string[] | undefined) ?? [];

        return ids.flatMap((itemId) =>
          (options.participants ?? []).map((edge) => ({ ...edge, item_id: itemId })),
        );
      }

      if (sql.includes('SELECT entity_id FROM ci.users')) {
        return [{ entity_id: null }];
      }

      if (sql.includes("->>'trust_mode'") || sql.includes('trust_mode')) {
        return [{ trust_mode: 'balanced' }];
      }

      if (sql.includes('FROM ci.users u')) {
        if (options.ownerQueryThrows) {
          throw new Error('relation "ci.users" does not exist');
        }

        return options.ownerRows ?? OWNER_ROWS;
      }

      // The stage summary's read-back of the ledger (telemetry/stageSummary).
      // Ahead of the bare count(*) branch below, which these would otherwise
      // capture — they are grouped counts, not a scalar one. Empty is the
      // honest answer for a fake that never wrote a ledger row: what is under
      // test in this file is the push's control flow, not its telemetry, which
      // has its own tests.
      if (sql.includes('AS unrouted') || sql.includes('DISTINCT ON (data_source)')) {
        return [];
      }

      if (sql.includes('FROM ci_import.staged_entities') && sql.includes('GROUP BY 1, 2')) {
        return [];
      }

      // settledCounts — checked before the bare count(*) branch, which its
      // second leg would otherwise capture.
      if (sql.includes("'item' AS kind")) {
        return [];
      }

      // pushEntities: nothing staged, so the graph is never called.
      if (sql.includes('identity_key AS "identityKey"')) {
        return [];
      }

      if (sql.includes('count(*)')) {
        return [{ count: String(rows.length) }];
      }

      if (sql.includes('media_type AS "mediaType"')) {
        if (servedBatch) {
          return [];
        }

        servedBatch = true;

        return rows;
      }

      throw new Error(`unexpected query: ${sql}`);
    }),
  };

  const communications = {
    createManyDetailed: jest.fn(async (_ctx: unknown, input: CreateCommunicationDto[]) => {
      communicationBatches += 1;

      if (options.failFirstCommunicationBatch && communicationBatches === 1) {
        throw new Error('batched communications write refused');
      }

      sent.push(...input);

      return input.map(() => ({ inserted: true }));
    }),
  };

  // Content is no longer inert on this path: the communications lane writes a
  // row per Discord attachment link before the message that references it.
  // The real service upserts on the provenance triple, so this one does too —
  // a re-sent row resolves onto the id it already had and reports
  // `inserted: false`, which is what makes the row-by-row retry of a failed
  // batch idempotent rather than merely tolerable.
  const contentIdsBySourceId = new Map<string, string>();
  const contents = {
    createManyDetailed: jest.fn(async (_ctx: unknown, input: CreateContentDto[]) => {
      contentSent.push(...input);

      const results = input.map((item) => {
        const key = String(item.source_id);
        const known = contentIdsBySourceId.get(key);

        if (known) {
          return { inserted: false, entity: { id: known } };
        }

        nextContentId += 1;
        const id = `content-${nextContentId}`;
        contentIdsBySourceId.set(key, id);

        return { inserted: true, entity: { id } };
      });

      return options.shortContentResults ? results.slice(0, -1) : results;
    }),
  };

  const noop = { createManyDetailed: jest.fn(async () => []), createDetailed: jest.fn(async () => []) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn((message: string, meta: unknown) => {
      warnings.push([message, meta]);
    }),
    debug: jest.fn(),
    error: jest.fn(),
  };

  const stage = new PushStage(
    dataSource as never,
    communications as never,
    contents as never,
    noop as never,
    noop as never,
    // The commerce plane — unused by this test's records, but the constructor
    // takes them.
    { upsertFromExtraction: jest.fn(async () => undefined) } as never,
    noop as never,
    { createMany: jest.fn(async () => undefined) } as never,
    { upsertForSubjects: jest.fn(async () => 0) } as never,
    { create: jest.fn(async () => undefined) } as never,
    noop as never,
    { ingest: jest.fn(async () => ({ entities: [], errors: [] })) } as never,
    { send: jest.fn(async () => undefined) } as never,
    logger as never,
  );

  return { stage, sent, contentSent, warnings };
}

const context: StageRunContext = {
  runId: RUN_ID,
  userId: USER_ID,
  stageId: STAGE_ID,
  scratchDir: '/tmp/does-not-matter',
  progress: jest.fn(async () => undefined),
} as unknown as StageRunContext;

describe('WhatsApp communications', () => {
  it('marks a message the owner sent outbound', async () => {
    const { stage, sent } = makeStage([whatsAppRow('Liam Broza', 'on my way')]);

    await stage.run(context);

    expect(sent).toHaveLength(1);
    expect(sent[0].direction).toBe('outbound');
  });

  it('marks a message from anyone else inbound', async () => {
    const { stage, sent } = makeStage([whatsAppRow('Alice Example', 'are we still on for tonight?')]);

    await stage.run(context);

    expect(sent[0].direction).toBe('inbound');
  });

  it('takes thread_id from Conversation, which the generic mapper never reads', async () => {
    // The silent half of the bug: toCommunicationInput reads
    // ThreadId/Thread/MessageID, and the WhatsApp importer stamps none of them.
    const { stage, sent } = makeStage([whatsAppRow('Alice Example', 'hi')]);

    await stage.run(context);

    expect(sent[0].thread_id).toBe('Family');
  });
});

describe('Discord attachment links', () => {
  /**
   * A Discord package ships NO attachment bytes: an upload survives only as a
   * signed cdn.discordapp.com URL in the message's `Attachments` field. The
   * mapping has always known how to catalogue those links
   * (`discordAttachmentContentInputs`) and nothing called it — a Discord
   * message routes to `['communications']` alone, so a message carrying three
   * uploads produced ZERO ci.content rows, and `attachments` stayed empty on
   * the row whose entire payload those uploads were.
   *
   * These drive the real `PushStage.run()` rather than the mapper for the same
   * reason the rest of this file does: the mapper was never in doubt, the wiring
   * was.
   */
  function discordRow(text: string, attachments: string): StagedItem {
    return stagedRow({
      dataSource: 'discord',
      metadata: {
        Conversation: 'general',
        Source: 'Discord',
        Text: text || undefined,
        Attachments: attachments,
      },
    });
  }

  const TWO_LINKS =
    'https://cdn.discordapp.com/attachments/1/2/Screenshot%20from%202020.png?ex=1&is=2&hm=3 ' +
    'https://cdn.discordapp.com/attachments/1/2/notes.pdf?ex=1';

  it('writes one content row per link and hands the ids to the message', async () => {
    const { stage, sent, contentSent } = makeStage([discordRow('look at these', TWO_LINKS)]);

    const outcome = await stage.run(context);

    expect(contentSent).toHaveLength(2);
    expect(contentSent[0]).toMatchObject({
      type: 'media',
      title: 'Screenshot from 2020.png',
      mimetype: 'image/png',
      source_type: 'ci-import-tools',
      source_system: 'discord',
      source_id: `${contentSent[0].source_id}`,
      url: 'https://cdn.discordapp.com/attachments/1/2/Screenshot%20from%202020.png?ex=1&is=2&hm=3',
    });
    // The identity convention MediaStage uses for the bytes-bearing half of the
    // lane: the message's own sourceId with an `:attachment:<n>` suffix.
    expect(contentSent.map((input) => input.source_id)).toEqual([
      `${sent[0].source_id}:attachment:0`,
      `${sent[0].source_id}:attachment:1`,
    ]);
    expect(contentSent[1]).toMatchObject({ type: 'file', title: 'notes.pdf' });

    // The whole point: the ids reach the column that references them.
    expect(sent[0].attachments).toEqual([
      { type: 'content', id: 'content-1' },
      { type: 'content', id: 'content-2' },
    ]);

    // Counted where they were written, so the post-push search-index and
    // graph-edge kicks fire for them.
    expect(outcome.detail).toMatchObject({ destinations: { communications: 1, content: 2 } });
  });

  it('gives an attachment-only message the payload it had nothing else to show', async () => {
    // `isDiscordAttachmentOnly` deliberately blanks the body of a message posted
    // with no caption, because the attachments ARE the payload. Until the links
    // were catalogued that left an entirely empty row.
    const { stage, sent } = makeStage([discordRow('', TWO_LINKS)]);

    await stage.run(context);

    expect(sent[0].content).toBe('');
    expect(sent[0].attachments).toHaveLength(2);
  });

  it('leaves a message with no links, and every other source, alone', async () => {
    const { stage, sent, contentSent } = makeStage([
      discordRow('just talking', ''),
      whatsAppRow('Alice Example', 'hi'),
    ]);

    await stage.run(context);

    expect(contentSent).toEqual([]);
    expect(sent.every((input) => input.attachments === undefined)).toBe(true);
  });

  it('still catalogues them when the batched write degrades to row by row', async () => {
    // The retry path builds its own inputs, so a lane wired only into the batch
    // path would silently drop every attachment on any batch that failed for an
    // unrelated reason.
    const { stage, sent, contentSent } = makeStage([discordRow('look at these', TWO_LINKS)], {
      failFirstCommunicationBatch: true,
    });

    const outcome = await stage.run(context);

    expect(sent).toHaveLength(1);
    expect(sent[0].attachments).toEqual([
      { type: 'content', id: 'content-1' },
      { type: 'content', id: 'content-2' },
    ]);
    // Re-sent, and resolved onto the same two rows — so the tally counts the
    // rows that exist, not the calls that were made.
    expect(contentSent).toHaveLength(4);
    expect(outcome.detail).toMatchObject({ destinations: { content: 2 } });
  });

  it('refuses to pair attachments onto messages when the write comes back short', async () => {
    // A short result array would re-pair every attachment after the gap onto the
    // wrong message. Failing the group hands it to the row-by-row retry, which
    // asks the same question one message at a time.
    const { stage, warnings } = makeStage([discordRow('a', TWO_LINKS), discordRow('b', TWO_LINKS)], {
      shortContentResults: true,
    });

    await stage.run(context);

    expect(warnings.map(([message]) => message)).toContain(
      'Batched push failed; retrying the group row by row',
    );
  });
});

describe('Facebook Messenger communications', () => {
  it('marks a message the owner sent outbound', async () => {
    const { stage, sent } = makeStage([messengerRow('Liam Broza', 'see you there')]);

    await stage.run(context);

    expect(sent[0].direction).toBe('outbound');
    // The Messenger contract also swaps the provenance triple's source_system.
    expect(sent[0].source_system).toBe('facebook_messenger');
    expect(sent[0].thread_id).toBe('Alice Example');
  });

  it('marks a message from anyone else inbound', async () => {
    const { stage, sent } = makeStage([messengerRow('Alice Example', 'see you there')]);

    await stage.run(context);

    expect(sent[0].direction).toBe('inbound');
  });
});

describe('when the owner cannot be resolved', () => {
  it('leaves every chat message inbound rather than guessing', async () => {
    const { stage, sent, warnings } = makeStage(
      [whatsAppRow('Liam Broza', 'on my way'), messengerRow('Liam Broza', 'see you there')],
      { ownerRows: [] },
    );

    await stage.run(context);

    expect(sent.map((input) => input.direction)).toEqual(['inbound', 'inbound']);
    expect(warnings.map(([message]) => message)).toContain(
      'No owner name resolved; chat messages stay inbound',
    );
  });

  it('survives a failed owner lookup without failing the push', async () => {
    const { stage, sent, warnings } = makeStage([whatsAppRow('Liam Broza', 'on my way')], {
      ownerQueryThrows: true,
    });

    const outcome = await stage.run(context);

    expect(outcome.detail).toMatchObject({ pushed: 1, failed: 0 });
    expect(sent[0].direction).toBe('inbound');
    // The thread name still lands: only direction depends on the owner.
    expect(sent[0].thread_id).toBe('Family');
    expect(warnings.map(([message]) => message)).toContain('Owner lookup failed; chat messages stay inbound');
  });
});

describe('every other communication', () => {
  it('still goes through the generic mapper, unchanged', async () => {
    const { stage, sent } = makeStage([
      stagedRow({
        dataSource: 'gmail',
        classification: 'email',
        metadata: {
          Subject: 'Lunch',
          ThreadId: 'thread-9',
          Direction: 'outgoing',
          Conversation: 'ignored by the generic path',
        },
      }),
    ]);

    await stage.run(context);

    expect(sent[0]).toMatchObject({
      direction: 'outbound',
      thread_id: 'thread-9',
      source_system: 'gmail',
      source_type: 'ci-import-tools',
    });
  });
});

describe('chat participants', () => {
  it('makes an inbound chat message point at whoever sent it', async () => {
    // imessage and whatsapp stage `participant`, not from/to — a 1:1 chat has
    // one other party, and the direction says which way it went. Honouring only
    // from/to left 432,173 real iMessages with no sender at all, staged WITH
    // 290,043 resolved participant edges and connected to nobody.
    const { stage, sent } = makeStage([whatsAppRow('Alice Example', 'hi')], {
      participants: [{ relation: 'participant', server_entity_id: 'entity-alice' }],
    });

    await stage.run(context);

    expect(sent[0].direction).toBe('inbound');
    expect(sent[0].from_entity_id).toBe('entity-alice');
    expect(sent[0].to_entity_ids ?? []).toEqual([]);
  });

  it('makes an outbound chat message point at the recipient, not the sender', async () => {
    // The owner sent it, so the other party is who it went TO. Filing them as
    // the sender would claim every message the owner wrote came from someone
    // else.
    const { stage, sent } = makeStage([whatsAppRow('Liam Broza', 'on my way')], {
      participants: [{ relation: 'participant', server_entity_id: 'entity-alice' }],
    });

    await stage.run(context);

    expect(sent[0].direction).toBe('outbound');
    expect(sent[0].from_entity_id).toBeUndefined();
    expect(sent[0].to_entity_ids).toEqual(['entity-alice']);
  });

  it('still prefers an explicit from/to edge over a participant', async () => {
    // The mail vocabulary is unchanged: gmail stages from/to/cc and must keep
    // winning, so a record carrying both is decided by the explicit edge.
    const { stage, sent } = makeStage(
      [stagedRow({ dataSource: 'gmail', classification: 'email', metadata: { Subject: 'Lunch' } })],
      {
        participants: [
          { relation: 'from', server_entity_id: 'entity-from' },
          { relation: 'participant', server_entity_id: 'entity-ignored' },
        ],
      },
    );

    await stage.run(context);

    expect(sent[0].from_entity_id).toBe('entity-from');
  });
});

describe('participant edges', () => {
  it('still ride on all three paths', async () => {
    // The staged edges are the whole point of resolving entities first, and the
    // specialised mappers must not cost a record its sender and recipients.
    const participants = [
      { relation: 'from', server_entity_id: 'entity-from' },
      { relation: 'to', server_entity_id: 'entity-to' },
      { relation: 'cc', server_entity_id: 'entity-cc' },
    ];
    const { stage, sent } = makeStage(
      [
        whatsAppRow('Alice Example', 'hi'),
        messengerRow('Alice Example', 'hi'),
        stagedRow({ dataSource: 'gmail', classification: 'email', metadata: { Subject: 'Lunch' } }),
      ],
      { participants },
    );

    await stage.run(context);

    expect(sent).toHaveLength(3);

    for (const input of sent) {
      expect(input.from_entity_id).toBe('entity-from');
      expect(input.to_entity_ids).toEqual(['entity-to', 'entity-cc']);
    }
  });
});
