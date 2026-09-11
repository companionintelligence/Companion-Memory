import { IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS, ImageDescriptionListener } from '../ImageDescriptionListener';

const USER = 'user-1';
const PREVIEW_ID = 'preview-1';
const ORIGINAL_ID = 'file-1';
const RENDERED = Buffer.from('rendered-jpeg');
const ANSWER = JSON.stringify({
  title: 'Gray Squirrel Foraging in Leaves',
  description: 'A squirrel on the ground.',
});

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeListener(opts: { enabled?: boolean; rendition?: unknown; content?: string } = {}) {
  const { enabled = true, content = ANSWER } = opts;
  const rendition = 'rendition' in opts ? opts.rendition : { jpeg: RENDERED, source: 'original' };
  const files = new Map<string, Record<string, unknown>>([
    [PREVIEW_ID, { id: PREVIEW_ID, parentId: ORIGINAL_ID, key: 'preview-key', contentType: 'image/jpeg' }],
    [ORIGINAL_ID, { id: ORIGINAL_ID, parentId: null, key: 'orig-key', contentType: 'image/heic' }],
  ]);
  const fileService = {
    findById: jest.fn(async (_ctx: unknown, id: string) => files.get(id) ?? null),
    update: jest.fn(async () => ({})),
  };
  const ollamaService = {
    resolveModel: jest.fn(async () => ({ model: 'gemma4:e4b', enableThinking: false, enableTools: false })),
    chat: jest.fn(
      async (
        _context: unknown,
        _messages: Array<{ role: string; content: string; images?: string[] }>,
        _options: unknown,
      ) => ({ message: { role: 'assistant', content } }),
    ),
  };
  const preference = { isEnabled: jest.fn(async () => enabled) };
  const renditionService = { render: jest.fn(async () => rendition) };
  const logger = makeLogger();
  const listener = new ImageDescriptionListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ollamaService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    preference as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renditionService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, fileService, ollamaService, renditionService, logger };
}

describe('ImageDescriptionListener', () => {
  it('shows the model a rendition of the ORIGINAL, with the preview only as fallback', async () => {
    const { listener, ollamaService, renditionService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    // Rendered from the parent original; the preview's key is offered as the
    // fallback and nothing else.
    expect(renditionService.render).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      expect.objectContaining({ id: ORIGINAL_ID, key: 'orig-key' }),
      'preview-key',
    );

    const [, messages] = ollamaService.chat.mock.calls[0]!;

    expect(messages[0].images).toEqual([RENDERED.toString('base64')]);
  });

  it('writes the title and description onto the ORIGINAL file', async () => {
    const { listener, fileService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(fileService.update).toHaveBeenCalledWith(expect.anything(), ORIGINAL_ID, {
      title: 'Gray Squirrel Foraging in Leaves',
      description: 'A squirrel on the ground.',
    });
  });

  // The two bounds that turned a 7s Gemma description into a 1.5s one: no
  // private chain of thought, and a ceiling on how much it may write back.
  it('calls the model with thinking off and a bounded output', async () => {
    const { listener, ollamaService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    const [, , options] = ollamaService.chat.mock.calls[0]!;

    expect(options).toMatchObject({
      enableThinking: false,
      enableTools: false,
      format: 'json',
      maxOutputTokens: IMAGE_DESCRIPTION_MAX_OUTPUT_TOKENS,
    });
  });

  it('completes without calling the model when nothing can be rendered', async () => {
    const { listener, ollamaService, fileService } = makeListener({ rendition: null });

    await expect(listener.handle({ userId: USER, previewId: PREVIEW_ID })).resolves.toBeUndefined();

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(fileService.update).not.toHaveBeenCalled();
  });

  it('completes without rendering or calling the model when description is off for the user', async () => {
    const { listener, ollamaService, renditionService } = makeListener({ enabled: false });

    await listener.handle({ userId: USER, previewId: PREVIEW_ID });

    expect(renditionService.render).not.toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('honours a capture source that already described the image', async () => {
    const { listener, renditionService } = makeListener();

    await listener.handle({ userId: USER, previewId: PREVIEW_ID, skipDescription: true });

    expect(renditionService.render).not.toHaveBeenCalled();
  });
});
