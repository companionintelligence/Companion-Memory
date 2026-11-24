import { EVENT_LOCATION_REOPENER, resolveEventLocationReopener } from '../eventLocationReopener';
import { EVENT_STATUS_REOPENER, resolveEventStatusReopener } from '../eventStatusReopener';
import { EVENT_TIME_REOPENER, resolveEventTimeReopener } from '../eventTimeReopener';

/**
 * The three contracts through which CalendarEventService tells the pipeline an
 * event's time moved (`EVENT_TIME_REOPENER`), its status called it off or
 * reinstated it (`EVENT_STATUS_REOPENER`), or its source moved its place
 * (`EVENT_LOCATION_REOPENER`). Memory owns all of them, the pipeline binds
 * them, and the service resolves each lazily. They have to throw, naming the
 * token, rather than return nothing: a write whose settling cannot run leaves a
 * row no stage ever revisits, so the write must fail and roll back. Wiring is
 * pipeline/__tests__/EventReopenersWiring.spec.ts.
 */
describe.each([
  ['EVENT_TIME_REOPENER', EVENT_TIME_REOPENER, resolveEventTimeReopener],
  ['EVENT_STATUS_REOPENER', EVENT_STATUS_REOPENER, resolveEventStatusReopener],
  ['EVENT_LOCATION_REOPENER', EVENT_LOCATION_REOPENER, resolveEventLocationReopener],
] as const)('%s', (name, token, resolve) => {
  it('is spelled as its own name, since Nest resolves it by that string', () => {
    expect(token).toBe(name);
  });

  it('resolves the binding with strict: false, since it lives in a sibling module', () => {
    const binding = { reopen: jest.fn() };
    const moduleRef = { get: jest.fn(() => binding) };

    expect(resolve(moduleRef as never)).toBe(binding);
    expect(moduleRef.get).toHaveBeenCalledWith(token, { strict: false });
  });

  it('throws, naming the token, in a service built without a ModuleRef', () => {
    expect(() => resolve(undefined)).toThrow(new RegExp(`${name} is unavailable \\(no ModuleRef\\)`));
  });

  it('throws, naming the token and the cause, when no module binds it', () => {
    const moduleRef = {
      get: jest.fn(() => {
        throw new Error('Nest could not find the provider');
      }),
    };

    expect(() => resolve(moduleRef as never)).toThrow(
      new RegExp(`No provider is bound to ${name}.*Nest could not find the provider`),
    );
  });

  it('throws rather than hand back nothing when the binding resolves to undefined', () => {
    const moduleRef = { get: jest.fn(() => undefined) };

    expect(() => resolve(moduleRef as never)).toThrow(new RegExp(`${name} is unavailable`));
  });
});
