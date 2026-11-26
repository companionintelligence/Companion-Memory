import { MemoryCompactionService } from './MemoryCompactionService';

const context = { userId: 'owner' };
// Every name an extraction below offers is written here: compaction drops a name
// that is not in the fragments it was shown.
const fragment = {
  id: 'raw-1',
  content:
    'My book is Dune. Conference starts at 2026-11-01T09:00:00-08:00. ' +
    'Sometime next week I will read an Unclassified reference. Gardening is my hobby.',
  createdAt: new Date('2026-10-20T10:00:00Z'),
};

interface HarnessOptions {
  /** The model's whole reply, when it is not just a list of entities. */
  reply?: unknown;
  /** The canonical person the user's own facts belong to. */
  self?: { entityId: string; aliases: string[] };
  /** Stands in for PersonService; most tests never reach it. */
  person?: object;
}

function harness(entities: unknown[], options: HarnessOptions = {}) {
  const concept = {
    search: jest.fn(async () => [{ id: 'concept', name: 'Gardening', description: 'likes roses' }]),
    update: jest.fn(),
  };
  const calendar = { search: jest.fn(async () => []), create: jest.fn(async () => [{ id: 'event' }]) };
  const content = { search: jest.fn(async () => []), create: jest.fn(async () => [{ id: 'book' }]) };
  const memory = { markProcessed: jest.fn() };
  const chat = jest.fn(async () => ({
    message: { content: JSON.stringify(options.reply ?? { entities, relationships: [] }) },
  }));
  const service = new MemoryCompactionService(
    { chat } as never,
    memory as never,
    (options.person ?? {}) as never,
    concept as never,
    { getSelfIdentity: jest.fn(async () => options.self ?? null) } as never,
    {} as never,
    {} as never,
    {} as never,
    { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    calendar as never,
    content as never,
  );

  return { service, calendar, content, concept, memory, chat };
}

it('promotes explicitly dated events and typed media through the real domain writers', async () => {
  const { service, calendar, content, memory } = harness([
    {
      type: 'Event',
      name: 'Conference',
      description: 'a conference',
      startTime: '2026-11-01T09:00:00-08:00',
      sourceIndexes: [1],
    },
    {
      type: 'content',
      name: 'Dune',
      description: 'a book the user owns',
      contentType: 'book',
      sourceIndexes: [1],
    },
  ]);
  await service.compactForUser(context, [fragment] as never);
  expect(calendar.create).toHaveBeenCalledWith(
    context,
    expect.objectContaining({
      title: 'Conference',
      start_time: new Date('2026-11-01T17:00:00Z'),
      time_source: 'source',
    }),
  );
  expect(content.create).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ title: 'Dune', type: 'book', text: expect.stringContaining('raw-1') }),
  );
  expect(memory.markProcessed).toHaveBeenCalled();
});

it('does not invent event instants or content subkinds when evidence is incomplete', async () => {
  const { service, calendar, content, memory } = harness([
    { type: 'event', name: 'Sometime next week', startTime: '2026-11-01' },
    { type: 'content', name: 'Unclassified reference' },
  ]);
  await service.compactForUser(context, [fragment] as never);
  expect(calendar.create).not.toHaveBeenCalled();
  expect(content.create).not.toHaveBeenCalled();
  // The names are in the fragment, so this extraction was used and not retried.
  expect(memory.markProcessed).toHaveBeenCalled();
});

it('adds new concept facts without discarding existing preferences', async () => {
  const { service, concept } = harness([
    { type: 'concept', name: 'Gardening', description: 'now grows vegetables' },
  ]);
  await service.compactForUser(context, [fragment] as never);
  expect(concept.update).toHaveBeenCalledWith(context, 'concept', {
    description: expect.stringContaining('likes roses\n\nMemory observation'),
  });
  expect(concept.update.mock.calls[0][2].description).toContain('now grows vegetables');
});

it('retries malformed typed extraction instead of treating it as an empty success', async () => {
  const { service, memory } = harness([null]);
  await service.compactForUser(context, [fragment] as never);
  expect(memory.markProcessed).not.toHaveBeenCalled();
});

it('retries a reply with no relationships list instead of reading it as nothing to extract', async () => {
  const { service, memory } = harness([], { reply: { entities: [] } });
  await service.compactForUser(context, [fragment] as never);
  expect(memory.markProcessed).not.toHaveBeenCalled();
});

it('appends what is said about the user to the canonical person instead of dropping it', async () => {
  const person = {
    findAll: jest.fn(async () => [{ id: 'self', name: 'Max', description: 'likes tea' }]),
    update: jest.fn(),
    create: jest.fn(),
  };
  const { service, memory } = harness(
    [{ type: 'person', name: 'the user', description: 'now drinks coffee', sourceIndexes: [1] }],
    { person, self: { entityId: 'self', aliases: ['the user'] } },
  );
  await service.compactForUser(context, [fragment] as never);
  expect(person.create).not.toHaveBeenCalled();
  expect(person.update).toHaveBeenCalledWith(
    context,
    'self',
    {
      description: expect.stringContaining(
        'likes tea\n\nMemory observation (captured 2026-10-20T10:00:00.000Z;',
      ),
    },
    { source: 'MemoryCompactionService.appendPersonObservation' },
  );
  expect(person.update.mock.calls[0][2].description).toContain('now drinks coffee');
  expect(memory.markProcessed).toHaveBeenCalled();
});

it('retries a failing graph write until the retry budget is spent', async () => {
  const { service, concept, memory } = harness([
    { type: 'concept', name: 'Gardening', description: 'now grows vegetables' },
  ]);
  concept.update.mockRejectedValue(new Error('database unavailable'));

  await service.compactForUser(context, [fragment] as never);
  await service.compactForUser(context, [fragment] as never);
  expect(memory.markProcessed).not.toHaveBeenCalled();

  // The third failure spends the budget: without it a write that always fails
  // would be re-extracted on every cron tick for good.
  await service.compactForUser(context, [fragment] as never);
  expect(memory.markProcessed).toHaveBeenCalledWith(expect.anything(), ['raw-1']);
});

it('leaves fragments that are not active, or not valid right now, alone', async () => {
  const { service, chat, memory } = harness([]);
  const soon = new Date(Date.now() + 60_000);
  const earlier = new Date(Date.now() - 60_000);
  await service.compactForUser(context, [
    { ...fragment, id: 'superseded', status: 'superseded' },
    { ...fragment, id: 'conflicted', status: 'conflicted' },
    { ...fragment, id: 'future', status: 'active', validFrom: soon },
    { ...fragment, id: 'expired', status: 'active', validUntil: earlier },
  ] as never);
  expect(chat).not.toHaveBeenCalled();
  expect(memory.markProcessed).not.toHaveBeenCalled();
});

it('runs the compactions of one user one after another', async () => {
  const { service, chat } = harness([]);
  let running = 0;
  let overlapped = false;
  chat.mockImplementation(async () => {
    running += 1;
    overlapped = overlapped || running > 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;

    return { message: { content: JSON.stringify({ entities: [], relationships: [] }) } };
  });

  await Promise.all([
    service.compactForUser(context, [{ ...fragment, id: 'first' }] as never),
    service.compactForUser(context, [{ ...fragment, id: 'second' }] as never),
  ]);

  expect(chat).toHaveBeenCalledTimes(2);
  expect(overlapped).toBe(false);
});
