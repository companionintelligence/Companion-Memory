import type { Acknowledgement } from '@ci/domains/events';
import type { FileUploadedPayload } from '@ci/domains/files/events';

import { type ParsedDocument, ParseStatus } from '../../types';
import { FileDocumentParseListener } from '../FileDocumentParseListener';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeAck(): Acknowledgement {
  return { done: jest.fn(), fail: jest.fn(), defer: jest.fn() };
}

function makeListener(fileOverrides: Record<string, unknown> = {}) {
  const queryCalls: unknown[][] = [];
  const chunkRepository = {
    manager: {
      query: jest.fn(async (_sql: string, params: unknown[]) => {
        queryCalls.push(params);

        return [];
      }),
    },
  };

  const file = {
    id: 'file-1',
    userId: 'user-1',
    bucket: 'files',
    key: 'user-1/file-1',
    contentType: 'application/pdf',
    filename: 'doc.pdf',
    parseStatus: null as string | null,
    ...fileOverrides,
  };

  const fileService = {
    findById: jest.fn(async () => file),
    getFileContent: jest.fn(async () => new Uint8Array([1, 2, 3])),
  };

  const parsedDocument: ParsedDocument = {
    parser: { name: 'markitdown', version: '1.0.0' },
    title: 'Doc',
    language: 'en',
    sections: [{ sectionId: 's1', title: null, text: 'hello world', metadata: {} }],
    warnings: [],
  };

  const parserService = {
    canParse: jest.fn(() => true),
    parse: jest.fn(async () => parsedDocument),
  };

  const chunkDtos = [
    {
      fileId: 'file-1',
      userId: 'user-1',
      chunkIndex: 0,
      content: 'hello world',
      sectionTitle: null,
      sourceLocator: null,
      parserName: 'markitdown',
      parserVersion: '1.0.0',
      chunkerVersion: '1.2.0',
    },
  ];

  const chunkerService = {
    chunkDocument: jest.fn(() => chunkDtos),
  };

  const createdChunks = [{ id: 'chunk-1', chunkerVersion: '1.2.0' }];

  const chunkService = {
    deleteByFileId: jest.fn(async () => {}),
    createMany: jest.fn(async () => createdChunks),
  };

  const eventService = { send: jest.fn(async () => {}) };

  const logger = makeLogger();

  const listener = new FileDocumentParseListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chunkRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parserService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chunkerService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chunkService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  // @OnEvent wraps the descriptor at class-definition time in an
  // autoAcknowledge try/catch (see OnEvent.ts): it calls ack.done() when the
  // wrapped promise resolves and ack.fail() when it rejects, and never lets
  // the rejection reach the caller. Calling the method with an explicit ack
  // here goes through that same wrapper — the same path pg-boss's worker
  // drives — which is what makes the rethrow-vs-swallow fix observable.
  const call = (payload: FileUploadedPayload, ack: Acknowledgement) =>
    (
      listener as unknown as {
        parseDocument: (p: FileUploadedPayload, a: Acknowledgement) => Promise<void>;
      }
    ).parseDocument(payload, ack);

  return {
    call,
    queryCalls,
    file,
    fileService,
    parserService,
    chunkerService,
    chunkService,
    eventService,
    logger,
  };
}

describe('FileDocumentParseListener', () => {
  it('parses a document, persists chunks, and emits DocumentParsedEvent (happy path)', async () => {
    const { call, chunkService, eventService, queryCalls } = makeListener();
    const ack = makeAck();

    await call({ userId: 'user-1', fileId: 'file-1', thingCapture: false }, ack);

    expect(chunkService.deleteByFileId).toHaveBeenCalledWith('file-1');
    expect(chunkService.createMany).toHaveBeenCalledTimes(1);
    expect(eventService.send).toHaveBeenCalledWith(
      'document.parsed',
      expect.objectContaining({ fileId: 'file-1', userId: 'user-1', chunkIds: ['chunk-1'] }),
    );

    // First param bound in updateParseStatus's UPDATE is parse_status.
    const completedCall = queryCalls.find((params) => params[0] === ParseStatus.COMPLETED);
    expect(completedCall).toBeDefined();
    expect(ack.done).toHaveBeenCalledTimes(1);
    expect(ack.fail).not.toHaveBeenCalled();
  });

  /**
   * FileUploadedEvent legitimately re-fires for an existing file id on
   * hash-dedup uploads (the sibling FilePreviewGenerationListener has the
   * same guard against its own PREVIEW variant). Without this check a
   * re-upload of an already-parsed file re-parses it, deletes and
   * re-creates its chunks, and re-emits DocumentParsedEvent downstream.
   */
  it('skips re-parsing a file that already has a completed parse', async () => {
    const { call, parserService, chunkService, eventService, queryCalls, logger } = makeListener({
      parseStatus: ParseStatus.COMPLETED,
    });
    const ack = makeAck();

    await call({ userId: 'user-1', fileId: 'file-1', thingCapture: false }, ack);

    expect(parserService.parse).not.toHaveBeenCalled();
    expect(chunkService.deleteByFileId).not.toHaveBeenCalled();
    expect(chunkService.createMany).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
    expect(queryCalls).toHaveLength(0);
    expect(logger.log).toHaveBeenCalledWith('File already parsed, skipping', { fileId: 'file-1' });
    expect(ack.done).toHaveBeenCalledTimes(1);
  });

  it('still re-parses a file whose previous attempt failed', async () => {
    const { call, parserService, chunkService } = makeListener({ parseStatus: ParseStatus.FAILED });

    await call({ userId: 'user-1', fileId: 'file-1', thingCapture: false }, makeAck());

    expect(parserService.parse).toHaveBeenCalledTimes(1);
    expect(chunkService.createMany).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug: the catch block logged and updated parse_status to FAILED but
   * then returned normally, so originalMethod resolved and OnEvent's
   * autoAcknowledge wrapper called ack.done() even though nothing was parsed
   * — the job could never be retried or dead-lettered. Rethrowing routes it
   * to ack.fail() instead.
   */
  it('fails the job (ack.fail) on parse failure instead of silently ack.done()-ing it', async () => {
    const { call, parserService, queryCalls } = makeListener();
    const ack = makeAck();
    const parseError = new Error('parser sidecar unreachable');

    parserService.parse.mockRejectedValue(parseError);

    await expect(
      call({ userId: 'user-1', fileId: 'file-1', thingCapture: false }, ack),
    ).resolves.toBeUndefined();

    const failedCall = queryCalls.find((params) => params[0] === ParseStatus.FAILED);
    expect(failedCall).toBeDefined();
    expect(failedCall?.[1]).toBe('parser sidecar unreachable');
    expect(ack.done).not.toHaveBeenCalled();
    expect(ack.fail).toHaveBeenCalledTimes(1);
    expect(ack.fail).toHaveBeenCalledWith(parseError);
  });

  it('fails the job when persisting chunks fails', async () => {
    const { call, chunkService } = makeListener();
    const ack = makeAck();
    const writeError = new Error('DB write failed');

    chunkService.createMany.mockRejectedValue(writeError);

    await expect(
      call({ userId: 'user-1', fileId: 'file-1', thingCapture: false }, ack),
    ).resolves.toBeUndefined();

    expect(ack.done).not.toHaveBeenCalled();
    expect(ack.fail).toHaveBeenCalledWith(writeError);
  });
});
