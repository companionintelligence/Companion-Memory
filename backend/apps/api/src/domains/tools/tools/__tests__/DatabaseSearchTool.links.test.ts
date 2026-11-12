/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { SearchService } from '@ci/domains/search-next';

import { DatabaseSearchTool, itemLink, stripOwnerRecord, stripStorageAddress } from '../DatabaseSearchTool';

const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as LoggerService;
}

function emptyResolver() {
  return { findByIds: jest.fn().mockResolvedValue([]) };
}

function searchOf(items: { type: string; id: string }[]): SearchService {
  return {
    searchPage: jest.fn().mockResolvedValue({
      items,
      totalMatches: items.length,
      truncated: false,
      limit: 25,
      modeTaken: 'keyword',
    }),
  } as unknown as SearchService;
}

function makeTool(options: {
  search: SearchService;
  files?: { findByIds: jest.Mock };
  content?: { findByIds: jest.Mock; findIdsByFileIds: jest.Mock };
  events?: { findByIds: jest.Mock };
  people?: { findByIds: jest.Mock };
  answers?: { findByIds: jest.Mock };
  threads?: { findByIds: jest.Mock };
  places?: { findByIds: jest.Mock };
  browserActivities?: { findByIds: jest.Mock };
}) {
  const noop = emptyResolver();

  return new DatabaseSearchTool(
    (options.answers ?? noop) as any, // answerService
    (options.browserActivities ?? noop) as any, // browserActivityService
    noop as any, // communicationService
    noop as any, // conceptService
    (options.content ?? { ...emptyResolver(), findIdsByFileIds: jest.fn() }) as any,
    (options.events ?? noop) as any, // eventService
    { findByIds: jest.fn().mockResolvedValue([]) } as any, // fileChunkService
    (options.files ?? noop) as any,
    noop as any, // itemService
    noop as any, // noteService
    (options.people ?? noop) as any,
    (options.places ?? noop) as any, // placeService
    noop as any, // productModelService
    noop as any, // receiptService
    noop as any, // taskService
    (options.threads ?? noop) as any, // threadService
    options.search,
    logger(),
  );
}

describe('itemLink', () => {
  const none = new Map<string, string[]>();

  it('opens a typed entity at its page by raw id', () => {
    expect(itemLink('person', 'p1', none)).toBe('/people/p1');
    expect(itemLink('event', 'e1', none)).toBe('/events/e1');
    expect(itemLink('content', 'c1', none)).toBe('/content/c1');
  });

  it('routes a file through its content row, since a file has no page of its own', () => {
    expect(itemLink('file', 'f1', new Map([['f1', ['c1', 'c2']]]))).toBe('/content/c1');
  });

  it('gives no link to a file without a content row, rather than a path that 404s', () => {
    expect(itemLink('file', 'f1', none)).toBeUndefined();
  });

  it('gives no link to a type with no page', () => {
    expect(itemLink('thread', 't1', none)).toBeUndefined();
    expect(itemLink('browser-activity', 'b1', none)).toBeUndefined();
  });
});

describe('DatabaseSearchTool — item links', () => {
  it('strips the object-store address from a file hit, leaving link as its only path', async () => {
    // The presigned GET, trimmed to path + query as FileService.signFile hands
    // it over: `/companion/<key>` is the BUCKET and object key, not a route.
    // Live on 2026-09-21 the model copied exactly this as a page link.
    const photo = {
      id: 'f1',
      filename: 'IMG_1.jpg',
      title: 'Squirrel on Fence',
      bucket: 'companion',
      key: '6386746a-0c6a-4007-924b-5602524e64ef',
      hash: 'abc123',
      url: '/companion/6386746a-0c6a-4007-924b-5602524e64ef?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=e1c6',
    };
    const content = {
      ...emptyResolver(),
      findIdsByFileIds: jest.fn().mockResolvedValue(new Map([['f1', ['c1']]])),
    };
    const tool = makeTool({
      search: searchOf([{ type: 'file', id: 'f1' }]),
      files: { findByIds: jest.fn().mockResolvedValue([photo]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'squirrel' });

    expect(result.data?.items).toEqual([
      { id: 'f1', filename: 'IMG_1.jpg', title: 'Squirrel on Fence', type: 'file', link: '/content/c1' },
    ]);
    expect(JSON.stringify(result.data)).not.toContain('/companion/');
  });

  it('stripStorageAddress keeps every other field intact', () => {
    const file = {
      id: 'f1',
      filename: 'a.jpg',
      url: '/companion/k',
      bucket: 'companion',
      key: 'k',
      hash: 'h',
    };

    expect(stripStorageAddress(file as any)).toEqual({ id: 'f1', filename: 'a.jpg' });
  });

  it('stamps every hit with its type and a link when one exists', async () => {
    const photo = { id: 'f1', filename: 'IMG_1.jpg', title: 'Squirrel on Fence' };
    const person = { id: 'p1', name: 'Ada' };
    const search = searchOf([
      { type: 'file', id: 'f1' },
      { type: 'person', id: 'p1' },
    ]);
    const content = {
      ...emptyResolver(),
      findIdsByFileIds: jest.fn().mockResolvedValue(new Map([['f1', ['c1']]])),
    };
    const tool = makeTool({
      search,
      files: { findByIds: jest.fn().mockResolvedValue([photo]) },
      people: { findByIds: jest.fn().mockResolvedValue([person]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'squirrel' });

    expect(result.success).toBe(true);
    expect(result.data?.items).toEqual([
      { ...photo, type: 'file', link: '/content/c1' },
      { ...person, type: 'person', link: '/people/p1' },
    ]);
    expect(content.findIdsByFileIds).toHaveBeenCalledWith({ userId: CONTEXT.userId }, ['f1']);
  });

  it('omits the link key, not the hit, for a file with no content row', async () => {
    const photo = { id: 'f1', filename: 'IMG_1.jpg' };
    const content = { ...emptyResolver(), findIdsByFileIds: jest.fn().mockResolvedValue(new Map()) };
    const tool = makeTool({
      search: searchOf([{ type: 'file', id: 'f1' }]),
      files: { findByIds: jest.fn().mockResolvedValue([photo]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'anything' });

    expect(result.data?.items).toEqual([{ ...photo, type: 'file' }]);
    expect(result.data?.items[0]).not.toHaveProperty('link');
  });

  it('does not look up content rows when no file hit hydrated', async () => {
    const content = { ...emptyResolver(), findIdsByFileIds: jest.fn() };
    const tool = makeTool({
      search: searchOf([{ type: 'file', id: 'missing' }]),
      files: { findByIds: jest.fn().mockResolvedValue([null]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'anything' });

    expect(result.data?.items).toEqual([]);
    expect(content.findIdsByFileIds).not.toHaveBeenCalled();
  });
});

// A photo hit's only meaningful date. `createdAt` on both a file and its content row is when it was
// imported, and a Drive import lands a whole library in one evening (2026-11-11), so the model
// reported "most recent" photos from 2019 with nothing on the hit to say otherwise.
describe('DatabaseSearchTool — when a photo was taken', () => {
  const TAKEN = new Date('2026-04-18T23:20:58Z');
  const photoEvent = { id: 'e1', startTime: TAKEN };

  it("stamps a photo content hit with its media event's start as takenAt", async () => {
    const row = { id: 'c1', type: 'media', eventId: 'e1', createdAt: '2026-10-29T22:50:03Z' };
    const events = { findByIds: jest.fn().mockResolvedValue([photoEvent]) };
    const tool = makeTool({
      search: searchOf([{ type: 'content', id: 'c1' }]),
      content: { findByIds: jest.fn().mockResolvedValue([row]), findIdsByFileIds: jest.fn() },
      events,
    });

    const result = await tool.execute(CONTEXT, { query: 'cat' });

    expect(result.data?.items).toEqual([
      { ...row, type: 'content', link: '/content/c1', takenAt: '2026-04-18T23:20:58.000Z' },
    ]);
    expect(events.findByIds).toHaveBeenCalledWith({ userId: CONTEXT.userId }, ['e1']);
  });

  it('dates a file hit through the content row its link opens, fetching that row', async () => {
    const photo = { id: 'f1', filename: 'IMG_1.jpg' };
    const content = {
      // The page held no content hit, so the file's content row is fetched for its event.
      findByIds: jest.fn(async (_context: unknown, ids: string[]) =>
        ids.map((id) => (id === 'c1' ? { id: 'c1', type: 'media', eventId: 'e1' } : null)),
      ),
      findIdsByFileIds: jest.fn().mockResolvedValue(new Map([['f1', ['c1', 'c2']]])),
    };
    const tool = makeTool({
      search: searchOf([{ type: 'file', id: 'f1' }]),
      files: { findByIds: jest.fn().mockResolvedValue([photo]) },
      content,
      events: { findByIds: jest.fn().mockResolvedValue([photoEvent]) },
    });

    const result = await tool.execute(CONTEXT, { query: 'cat' });

    expect(result.data?.items).toEqual([
      { ...photo, type: 'file', link: '/content/c1', takenAt: '2026-04-18T23:20:58.000Z' },
    ]);
    expect(content.findByIds).toHaveBeenLastCalledWith({ userId: CONTEXT.userId }, ['c1']);
  });

  it('leaves takenAt off an undated photo, and off content that is not media', async () => {
    const rows = [
      { id: 'c1', type: 'media', eventId: null },
      { id: 'c2', type: 'google_drive_document', eventId: 'e1' },
    ];
    const events = { findByIds: jest.fn().mockResolvedValue([]) };
    const tool = makeTool({
      search: searchOf([
        { type: 'content', id: 'c1' },
        { type: 'content', id: 'c2' },
      ]),
      content: { findByIds: jest.fn().mockResolvedValue(rows), findIdsByFileIds: jest.fn() },
      events,
    });

    const result = await tool.execute(CONTEXT, { query: 'cat' });

    for (const item of result.data?.items ?? []) {
      expect(item).not.toHaveProperty('takenAt');
    }

    expect(events.findByIds).toHaveBeenCalledWith({ userId: CONTEXT.userId }, []);
  });

  it('fetches no content rows when the page holds no photos', async () => {
    const content = { ...emptyResolver(), findIdsByFileIds: jest.fn() };
    const tool = makeTool({
      search: searchOf([{ type: 'person', id: 'p1' }]),
      people: { findByIds: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Ada' }]) },
      content,
    });

    const result = await tool.execute(CONTEXT, { query: 'Ada' });

    expect(result.data?.items[0]).not.toHaveProperty('takenAt');
    // Only the page's own (empty) content hydration: nothing fetched for dates.
    expect(content.findByIds).toHaveBeenCalledTimes(1);
  });
});

describe('DatabaseSearchTool drops the account record', () => {
  // ThreadService, AnswerService and PlaceService load the `user` relation, so a
  // thread hit handed the model the whole account row. Seen in a stored tool
  // message after "Show me photos from Blue Bottle Coffee" matched an earlier
  // thread. BrowserActivityService loads it too and passes the raw entity on,
  // password hash included.
  const owner = {
    id: CONTEXT.userId,
    name: 'Hb Tester',
    email: 'tester@example.com',
    entityId: 'e1',
    onboarded: true,
    role: 'admin',
    passwordSetAt: new Date('2026-10-01T00:00:00Z'),
    emailProvenAt: new Date('2026-10-01T00:00:00Z'),
  };

  it('keeps it out of thread and answer hits but keeps every other field', async () => {
    const thread = {
      id: 't1',
      name: 'Blue Bottle Coffee',
      description: null,
      isArchived: false,
      generationStatus: 'idle',
      kind: 'chat',
      user: owner,
    };
    const answer = { id: 'a1', answer: 'Oat milk flat white', user: owner };
    const tool = makeTool({
      search: searchOf([
        { type: 'thread', id: 't1' },
        { type: 'answer', id: 'a1' },
      ]),
      threads: { findByIds: jest.fn().mockResolvedValue([thread]) },
      answers: { findByIds: jest.fn().mockResolvedValue([answer]) },
    });

    const result = await tool.execute(CONTEXT, { query: 'blue bottle' });
    const { user: _threadUser, ...threadFields } = thread;
    const { user: _answerUser, ...answerFields } = answer;

    expect(result.data?.items).toEqual([
      { ...threadFields, type: 'thread' },
      { ...answerFields, type: 'answer' },
    ]);
    const sent = JSON.stringify(result.data);
    expect(sent).not.toContain('tester@example.com');
    expect(sent).not.toContain('passwordSetAt');
    expect(sent).not.toContain('emailProvenAt');
  });

  it('keeps it out of place and browser-visit hits, where the raw row carries the password hash', async () => {
    const place = { id: 'pl1', name: 'Blue Bottle Coffee', userId: CONTEXT.userId, user: owner };
    const visit = {
      id: 'b1',
      url: 'https://bluebottlecoffee.com',
      title: 'Blue Bottle Coffee',
      user_id: CONTEXT.userId,
      user: { ...owner, password: '$2b$10$not-a-real-hash' },
    };
    const tool = makeTool({
      search: searchOf([
        { type: 'place', id: 'pl1' },
        { type: 'browser-activity', id: 'b1' },
      ]),
      places: { findByIds: jest.fn().mockResolvedValue([place]) },
      browserActivities: { findByIds: jest.fn().mockResolvedValue([visit]) },
    });

    const result = await tool.execute(CONTEXT, { query: 'blue bottle' });
    const { user: _placeUser, ...placeFields } = place;
    const { user: _visitUser, ...visitFields } = visit;

    expect(result.data?.items).toEqual([
      { ...placeFields, type: 'place', link: '/places/pl1' },
      { ...visitFields, type: 'browser-activity' },
    ]);
    const sent = JSON.stringify(result.data);
    expect(sent).not.toContain('tester@example.com');
    expect(sent).not.toContain('not-a-real-hash');
  });

  it('stripOwnerRecord leaves an entity with no user untouched', () => {
    expect(stripOwnerRecord({ id: 'p1', name: 'Ada' })).toEqual({ id: 'p1', name: 'Ada' });
  });
});
