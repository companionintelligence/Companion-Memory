import { describe, expect, it } from 'vitest';

import { replicaStartOptions } from './backgroundSync';
import { AppSchema } from './schema';

describe('replicaStartOptions', () => {
  it("is what the app's own client sends the core on start: no parameters or streams, defaults on, the app's schema", () => {
    const options = JSON.parse(replicaStartOptions());

    expect(options).toEqual({
      parameters: {},
      app_metadata: {},
      active_streams: [],
      include_defaults: true,
      schema: JSON.parse(JSON.stringify(AppSchema.toJSON())),
    });
    // The raw search table is what the background run must write into, as the app does.
    expect(options.schema.raw_tables.map((table: { name: string }) => table.name)).toContain(
      'mobile_search_documents',
    );
  });
});
