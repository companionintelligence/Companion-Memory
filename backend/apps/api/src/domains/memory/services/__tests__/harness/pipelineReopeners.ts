import { EVENT_STATUS_REOPENER } from '../../eventStatusReopener';
import { EVENT_TIME_REOPENER } from '../../eventTimeReopener';

/**
 * What PipelineModule binds to `EVENT_TIME_REOPENER` and `EVENT_STATUS_REOPENER`,
 * as stand-ins that only record being asked — for a `CalendarEventService`
 * built by hand, which a move or a status change that crosses the line between
 * "still counts" and "called off" throws without.
 *
 * `moduleRef` answers by token, as Nest's does and as a stub that returns one
 * object for every token cannot: a service that resolves the wrong token gets
 * an error here instead of a method it did not mean to call.
 */
export function stubPipelineReopeners() {
  const time = { reopenTimeDecisions: jest.fn(async (..._args: unknown[]): Promise<number> => 0) };
  const status = { reopenStatusDecisions: jest.fn(async (..._args: unknown[]): Promise<number> => 0) };
  const bindings: Record<string, unknown> = {
    [EVENT_TIME_REOPENER]: time,
    [EVENT_STATUS_REOPENER]: status,
  };

  const moduleRef = {
    get: (token: string): unknown => {
      if (!(token in bindings)) {
        throw new Error(`No provider is bound to ${token}.`);
      }

      return bindings[token];
    },
  };

  return { time, status, moduleRef };
}
