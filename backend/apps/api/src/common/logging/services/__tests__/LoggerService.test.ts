import { LoggerService } from '../LoggerService';

/**
 * The argument-shape rules every call site in the repository depends on.
 *
 * `resolveArgs` is what decides whether a failure reads as a sentence a person
 * can grep for or as whatever text the exception happened to carry, and it is
 * invisible from the call site — so the shapes are pinned here rather than
 * rediscovered one reversed `logger.error` at a time.
 */
describe('LoggerService argument shapes', () => {
  function build() {
    const service = new LoggerService();
    const sink = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    (service as unknown as { logger: typeof sink }).logger = sink;

    return { service, sink };
  }

  it('takes a leading string as the message and the rest as data', () => {
    const { service, sink } = build();

    service.error('Import stage failed', { runId: 'run-1' });

    expect(sink.error).toHaveBeenCalledWith({ data: { runId: 'run-1' } }, 'Import stage failed');
  });

  it('takes a leading Error as the message — which is why call sites must not do that', () => {
    const { service, sink } = build();
    const failure = new Error('database is down');

    service.error(failure, { message: 'Staged upload purge failed' });

    // The sentence is now `data.message` and the message is the raw error text.
    // Documented, not endorsed: this is the shape the import crons were moved
    // off, and the assertion exists so a "fix" that silently swaps them is a
    // visible change rather than a quiet one.
    expect(sink.error).toHaveBeenCalledWith(
      { err: failure, data: { message: 'Staged upload purge failed' } },
      'database is down',
    );
  });

  /**
   * The shape that makes the good call site possible. pino runs its serializers
   * on top-level keys only, so an Error nested under `data` is written by
   * JSON.stringify — which finds no enumerable properties on an Error and
   * produces `{}`, losing the message, the stack and the cause.
   */
  it('hoists an Error out of the data so pino can serialize it', () => {
    const { service, sink } = build();
    const failure = new Error('unzip: cannot find central directory');

    service.error('Import stage failed', { err: failure, runId: 'run-1', kind: 'unpack' });

    expect(sink.error).toHaveBeenCalledWith(
      { err: failure, data: { runId: 'run-1', kind: 'unpack' } },
      'Import stage failed',
    );
  });

  it('hoists an `error` key too, and leaves a non-Error under either name alone', () => {
    const { service, sink } = build();
    const failure = new Error('no such file');

    service.warn('Could not store staged media', { error: failure });
    expect(sink.warn).toHaveBeenCalledWith({ err: failure }, 'Could not store staged media');

    // What plenty of call sites pass instead: the message, already extracted.
    // That is data, and hoisting it would make pino's error serializer run over
    // a string.
    service.warn('Could not store staged media', { error: 'no such file' });
    expect(sink.warn).toHaveBeenCalledWith(
      { data: { error: 'no such file' } },
      'Could not store staged media',
    );
  });
});
