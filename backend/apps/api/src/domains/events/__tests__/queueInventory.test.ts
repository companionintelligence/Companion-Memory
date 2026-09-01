import { EventListenerRegistry } from '../event-registration';
import { queueInventory } from '../queueInventory';

/**
 * What the Controls card needs to know before an operator can safely switch a
 * queue off: what is on it, which process runs it, whether anything on it is
 * work a person is waiting on, and what ceiling the code already imposes.
 *
 * Built from the live `@OnEvent` registry rather than a hand-kept list, which is
 * the property most worth pinning — a queue added by a new listener has to be
 * controllable the day it ships, not the day someone remembers to add it to a
 * second copy of the list.
 */

beforeEach(() => {
  EventListenerRegistry.clear();
});

afterEach(() => {
  EventListenerRegistry.clear();
});

describe('queueInventory', () => {
  it('lists every queue a listener registered, with its events', () => {
    EventListenerRegistry.register('note.created', 'NoteSearchListener', 'index', 'search-index');
    EventListenerRegistry.register('note.updated', 'NoteSearchListener', 'reindex', 'search-index');
    EventListenerRegistry.register(
      'file.uploaded',
      'ImageDescriptionListener',
      'describe',
      'image-description',
    );

    expect(queueInventory().map((entry) => entry.queue)).toEqual(['image-description', 'search-index']);
    expect(queueInventory().find((entry) => entry.queue === 'search-index')?.events).toEqual([
      'note.created',
      'note.updated',
    ]);
  });

  it('carries the role and declared ceiling the queue registered with', () => {
    EventListenerRegistry.register('import.stage', 'ImportStageListener', 'run', 'import-stages', {
      role: 'worker',
      localConcurrency: 1,
    });

    const [entry] = queueInventory();

    expect(entry).toMatchObject({ role: 'worker', localConcurrency: 1 });
  });

  it('defaults an undeclared queue to the web role and no ceiling of its own', () => {
    EventListenerRegistry.register('note.created', 'NoteSearchListener', 'index', 'search-index');

    expect(queueInventory()[0]).toMatchObject({ role: 'web', localConcurrency: null });
  });

  it('marks a queue interactive when anything on it is work a person waits for', () => {
    EventListenerRegistry.register('chat.generate', 'ChatGenerateListener', 'generate', 'llm');
    EventListenerRegistry.register('chat.summarization', 'ChatSummaryListener', 'summarize', 'llm');
    EventListenerRegistry.register('note.created', 'NoteSearchListener', 'index', 'search-index');

    const byName = new Map(queueInventory().map((entry) => [entry.queue, entry]));

    // `chat.generate` is the taxonomy's only interactive event today, and the
    // global "pause background work" switch spares its queue on that basis.
    expect(byName.get('llm')?.interactive).toBe(true);
    expect(byName.get('search-index')?.interactive).toBe(false);
  });

  it('reports every category on a mixed queue, most common first', () => {
    // `default` is the real case: sixteen listeners spanning graph writes,
    // new-user seeding and model calls. Showing it under one category would tell
    // an operator that switching it off costs one thing when it costs five.
    EventListenerRegistry.register('person.created', 'GraphListener', 'a', 'default');
    EventListenerRegistry.register('place.created', 'GraphListener', 'b', 'default');
    EventListenerRegistry.register('chat.summarization', 'SummaryListener', 'c', 'default');

    const [entry] = queueInventory();

    expect(entry.categories.length).toBeGreaterThan(1);
    expect(entry.categories[0]).toBe('search');
  });

  it('splits the registry key correctly for an event name that contains dots', () => {
    EventListenerRegistry.register('smart.rotation.work', 'SmartRotationListener', 'run', 'smart-rotation');

    expect(queueInventory()[0]?.events).toEqual(['smart.rotation.work']);
  });
});
