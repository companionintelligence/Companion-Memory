import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import type { DatabaseSearchTool } from '../DatabaseSearchTool';
import { MediaFindPhotosTool } from '../MediaFindPhotosTool';

/**
 * "What is the most recent picture of a squirrel in my memory?" Two searches came back in
 * relevance order; the model said "let me pull the newest one specifically" and ended its turn
 * without calling anything, because this tool had no way to ask for newest first.
 */
const CONTEXT = { userId: '00000000-0000-0000-0000-0000000000aa' } as RequestContext;

function makeTool() {
  const search = {
    run: jest.fn().mockResolvedValue({
      summary: 'text search',
      totalMatches: 0,
      truncated: false,
      limit: 25,
      mode: 'keyword',
      items: [],
    }),
  };
  const places = { photosAtNamedPlace: jest.fn().mockResolvedValue({ places: [], fileIds: [], total: 0 }) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const tool = new MediaFindPhotosTool(
    search as unknown as DatabaseSearchTool,
    places as never,
    logger as unknown as LoggerService,
  );

  return { tool, search };
}

describe('media.findPhotos sort', () => {
  it('asks the search for newest first when the model sets sort: recent', async () => {
    const { tool, search } = makeTool();

    await tool.execute(CONTEXT, { query: 'squirrel', sort: 'recent' });

    expect(search.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: 'squirrel', entityTypes: ['content'], sort: 'recent' }),
      { mediaContentOnly: true },
    );
  });

  // Only the content row links the media event that says when a photo was taken; a file's own
  // time is when it was imported, so "newest first" over files was import order.
  it('searches photo and video content rows, not files', async () => {
    const { tool, search } = makeTool();

    await tool.execute(CONTEXT, { query: 'squirrel' });

    expect(search.run.mock.calls[0][1]).toMatchObject({ entityTypes: ['content'] });
    expect(search.run.mock.calls[0][2]).toEqual({ mediaContentOnly: true });
  });

  it('accepts the one-element array a small model writes, as the search tool does', async () => {
    const { tool, search } = makeTool();

    await tool.execute(CONTEXT, { query: 'squirrel', sort: ['recent'] });

    expect(search.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sort: 'recent' }), {
      mediaContentOnly: true,
    });
  });

  it('leaves the order to the search when no sort is asked for', async () => {
    const { tool, search } = makeTool();

    await tool.execute(CONTEXT, { query: 'squirrel' });

    expect(search.run.mock.calls[0][1]).not.toHaveProperty('sort');
  });

  it('offers the sort to both the full and the on-device model', () => {
    const { tool } = makeTool();
    const full = tool.schema.parameters as { properties: Record<string, { enum?: string[] }> };
    const local = tool.schema.local?.parameters as { properties: Record<string, { enum?: string[] }> };

    expect(full.properties.sort.enum).toEqual(['relevance', 'recent']);
    expect(local.properties.sort.enum).toEqual(['recent']);
  });
});
