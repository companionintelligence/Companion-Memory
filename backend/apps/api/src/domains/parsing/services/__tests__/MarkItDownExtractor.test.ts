import { UnparseableDocumentError } from '../DocumentExtractor';
import { MarkItDownExtractor, PARSER_REQUEST_TIMEOUT_MS } from '../MarkItDownExtractor';

function extractor(): MarkItDownExtractor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new MarkItDownExtractor({ setContext: jest.fn(), log: jest.fn() } as any);
}

const request = { fileBytes: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf', filename: 'a.pdf' };

describe('MarkItDownExtractor', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('bounds the whole request with a timeout', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ sections: [], warnings: [] })));
    global.fetch = fetchMock as unknown as typeof fetch;

    await extractor().parse(request);

    expect(timeout).toHaveBeenCalledWith(PARSER_REQUEST_TIMEOUT_MS);
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({
      signal: timeout.mock.results[0].value,
    });
  });

  it.each([413, 415, 422, 504])('reports a %i as a document the parser refused', async (status) => {
    global.fetch = jest.fn(async () => new Response('no', { status })) as unknown as typeof fetch;

    await expect(extractor().parse(request)).rejects.toBeInstanceOf(UnparseableDocumentError);
  });

  it.each([500, 502, 503])('leaves a %i retryable', async (status) => {
    global.fetch = jest.fn(async () => new Response('down', { status })) as unknown as typeof fetch;

    const error = await extractor()
      .parse(request)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnparseableDocumentError);
  });
});
