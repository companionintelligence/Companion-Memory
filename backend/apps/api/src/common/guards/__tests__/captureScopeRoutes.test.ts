import 'reflect-metadata';

import { CAPTURE_SCOPE, REQUIRE_SCOPES_KEY } from '@ci/common/decorators';

import { DeviceController } from '../../../domains/devices/controllers/DeviceController';
import { IngestLifecycleController } from '../../../domains/ingest/controllers/IngestLifecycleController';

/**
 * A capture client's Portal token (the browser extension, Companion Capture) is confined to the
 * capture scope. Besides the `/v1/*` bulk routes it calls three device routes and the bulk-load
 * `finish`, so those grant the scope, and nothing else on the same controllers does.
 */
describe('routes a capture agent needs beyond bulk ingest', () => {
  const scopesOf = (controller: new (...args: never[]) => object, method: string): unknown =>
    Reflect.getMetadata(
      REQUIRE_SCOPES_KEY,
      (controller.prototype as Record<string, unknown>)[method] as object,
    ) ?? Reflect.getMetadata(REQUIRE_SCOPES_KEY, controller);

  it.each([
    [DeviceController, 'create'],
    [DeviceController, 'findAll'],
    [DeviceController, 'updateLastSeen'],
    [IngestLifecycleController, 'finish'],
  ] as const)('%p.%s grants the capture scope', (controller, method) => {
    expect(scopesOf(controller, method)).toEqual([CAPTURE_SCOPE]);
  });

  it.each([
    [DeviceController, 'findOne'],
    [DeviceController, 'update'],
    [DeviceController, 'remove'],
    [DeviceController, 'setPrimary'],
    [IngestLifecycleController, 'status'],
  ] as const)('%p.%s stays closed to scope-limited callers', (controller, method) => {
    expect(scopesOf(controller, method)).toBeUndefined();
  });
});
