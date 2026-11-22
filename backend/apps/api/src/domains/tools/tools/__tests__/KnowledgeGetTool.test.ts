/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { ENTRY_WINDOW_CHARACTERS } from '../compactSearchHit';
import { DatabaseSearchTool } from '../DatabaseSearchTool';
import { KnowledgeGetTool } from '../KnowledgeGetTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;
const EMAIL_ID = '01a1aca4-b1dc-76da-94a1-0cb67ab7caea';

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

/** A DatabaseSearchTool whose only resolver with rows is communications. */
function makeTools(communications: unknown[]) {
  const noop = { findByIds: jest.fn().mockResolvedValue([]) };
  const communicationService = { findByIds: jest.fn().mockResolvedValue(communications) };
  const search = new DatabaseSearchTool(
    noop as any, // answerService
    noop as any, // browserActivityService
    communicationService as any,
    noop as any, // conceptService
    { ...noop, findIdsByFileIds: jest.fn() } as any, // contentService
    noop as any, // eventService
    noop as any, // fileChunkService
    noop as any, // fileService
    noop as any, // itemService
    noop as any, // noteService
    noop as any, // personService
    noop as any, // placeService
    noop as any, // productModelService
    noop as any, // receiptService
    noop as any, // taskService
    noop as any, // threadService
    {} as any, // searchService
    logger(),
  );

  return { tool: new KnowledgeGetTool(search, logger()), communicationService };
}

const body = `Your Grubhub+ membership has been extended.\n${'Use code PERKS20 for 20% off. '.repeat(250)}`;

describe('KnowledgeGetTool', () => {
  it('reads an email body a window at a time', async () => {
    const { tool, communicationService } = makeTools([
      { id: EMAIL_ID, subject: 'Your Grubhub+ membership has been extended', content: body, userId: 'u1' },
    ]);

    const first = await tool.execute(CONTEXT, { id: EMAIL_ID, type: 'communication' });

    expect(communicationService.findByIds).toHaveBeenCalledWith(expect.anything(), [EMAIL_ID]);
    expect(first.success).toBe(true);
    expect(first.data?.found).toBe(true);
    expect(first.data?.entry).toMatchObject({
      id: EMAIL_ID,
      type: 'communication',
      link: `/communications/${EMAIL_ID}`,
      textField: 'content',
      offset: 0,
      nextOffset: ENTRY_WINDOW_CHARACTERS,
    });
    expect(first.data?.entry?.content).toHaveLength(ENTRY_WINDOW_CHARACTERS);
    expect(first.data?.summary).toContain(`offset ${ENTRY_WINDOW_CHARACTERS}`);

    const second = await tool.execute(CONTEXT, {
      id: EMAIL_ID,
      type: 'communication',
      offset: first.data?.entry?.nextOffset,
    });

    expect(second.data?.entry?.nextOffset).toBeUndefined();
    expect(second.data?.summary).toContain('the end of the text');
  });

  it('says so when the entry is not there', async () => {
    const { tool } = makeTools([]);

    const result = await tool.execute(CONTEXT, { id: EMAIL_ID, type: 'communication' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      found: false,
      summary: `No communication with id ${EMAIL_ID}. Check the id and type against the search hit.`,
    });
  });

  it('refuses an id that is not a UUID', async () => {
    const { tool } = makeTools([]);

    const result = await tool.execute(CONTEXT, { id: '/communications/x', type: 'communication' });

    expect(result.success).toBe(false);
  });
});
