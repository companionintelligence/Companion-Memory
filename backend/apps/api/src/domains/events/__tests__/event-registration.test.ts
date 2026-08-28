import { EventListenerRegistry } from '../event-registration';

/**
 * Registration is all-or-nothing.
 *
 * `register()` used to commit the listener entry and then merge `queueOptions`
 * into the STORED object one key at a time, throwing only when it reached a key
 * whose value conflicted. A registrant rejected on its second option had
 * therefore already written its first into the queue's options and already
 * added itself to the listener map — so the queue that boots is not the queue
 * any single `@OnEvent` declared, and the failure is not reproducible from the
 * source.
 */
describe('EventListenerRegistry.register', () => {
  beforeEach(() => {
    EventListenerRegistry.clear();
  });

  afterEach(() => {
    EventListenerRegistry.clear();
  });

  it('leaves the queue options untouched when a later option in the same registration conflicts', () => {
    EventListenerRegistry.register('first.event', 'FirstListener', 'onFirst', 'shared', {
      policy: 'short',
      localConcurrency: 1,
    });

    expect(() =>
      // `expireInSeconds` merges cleanly and comes FIRST; `policy` is the
      // conflict. Merging as it goes is what let the accepted half of a
      // rejected registration stick.
      EventListenerRegistry.register('second.event', 'SecondListener', 'onSecond', 'shared', {
        expireInSeconds: 900,
        policy: 'stately',
      }),
    ).toThrow(/Conflicting queueOptions.policy for queue shared/);

    expect(EventListenerRegistry.getQueueOptions('shared')).toEqual({
      policy: 'short',
      localConcurrency: 1,
    });
  });

  it('does not leave an orphan listener entry behind when the registration is rejected', () => {
    EventListenerRegistry.register('first.event', 'FirstListener', 'onFirst', 'shared', {
      policy: 'short',
    });

    expect(() =>
      EventListenerRegistry.register('second.event', 'SecondListener', 'onSecond', 'shared', {
        policy: 'stately',
      }),
    ).toThrow();

    expect(EventListenerRegistry.getListeners().map(([key]) => key)).toEqual(['first.event:shared']);
    expect(EventListenerRegistry.getQueuesFor('second.event')).toEqual(new Set());
  });

  it('still merges compatible options from several registrants onto one queue', () => {
    EventListenerRegistry.register('first.event', 'FirstListener', 'onFirst', 'shared', {
      policy: 'short',
    });
    EventListenerRegistry.register('second.event', 'SecondListener', 'onSecond', 'shared', {
      policy: 'short',
      expireInSeconds: 900,
    });

    expect(EventListenerRegistry.getQueueOptions('shared')).toEqual({
      policy: 'short',
      expireInSeconds: 900,
    });
    expect(EventListenerRegistry.getQueuesFor('second.event')).toEqual(new Set(['shared']));
  });
});
