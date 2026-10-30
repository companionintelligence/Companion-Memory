import { AppSchema } from './schema';

/**
 * The options the app's own PowerSync client passes the core's `powersync_control('start')`,
 * for the phone apps' background replica sync to send the same.
 *
 * Mirrors `startCommand` in `@powersync/common`'s `AbstractStreamingSyncImplementation` with the
 * provider's `connect(connector)` defaults: no parameters, no app metadata, no explicit stream
 * subscriptions, default streams included, and the app's schema -- the part that matters, since
 * the core writes rows into the tables it describes (the raw search documents table among
 * them). A provider that starts passing connect options has to pass them here too.
 */
export function replicaStartOptions(): string {
  return JSON.stringify({
    parameters: {},
    app_metadata: {},
    active_streams: [],
    include_defaults: true,
    schema: AppSchema.toJSON(),
  });
}
