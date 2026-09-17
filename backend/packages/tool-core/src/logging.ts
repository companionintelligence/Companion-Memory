/**
 * The logging surface the registry needs, and nothing more.
 *
 * Four levels and a context name — the intersection of every logger this package is likely to be
 * handed. The API passes its Nest-provided pino `LoggerService` straight in; a CLI can pass a
 * console shim. Declared here rather than imported so that a frontend which wants the registry
 * does not inherit a logging framework with it.
 *
 * `fields` is `unknown` rather than a record because the API's logger accepts an `Error` there as
 * well as a bag of fields, and narrowing it would reject the real implementation.
 */
export interface ToolCoreLogger {
  setContext(context: string): void;
  log(message: string, fields?: unknown): void;
  debug(message: string, fields?: unknown): void;
  warn(message: string, fields?: unknown): void;
  error(message: string, fields?: unknown): void;
}
