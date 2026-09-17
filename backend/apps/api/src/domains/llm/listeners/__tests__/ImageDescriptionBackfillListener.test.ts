import { ImageDescriptionBackfillRequestEvent, PreviewGeneratedEvent } from '@ci/domains/files';

import { ImageDescriptionBackfillListener } from '../ImageDescriptionBackfillListener';

const USER = 'user-1';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function candidates(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    previewId: `preview-${offset + i}`,
    parentFileId: `original-${offset + i}`,
  }));
}

function makeListener(pages: Array<ReturnType<typeof candidates>>) {
  const findUndescribedImagePreviews = jest.fn();
  for (const page of pages) {
    findUndescribedImagePreviews.mockResolvedValueOnce(page);
  }

  findUndescribedImagePreviews.mockResolvedValue([]);

  const eventService = { send: jest.fn(async () => ['job-id']) };
  const listener = new ImageDescriptionBackfillListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { findUndescribedImagePreviews } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeLogger() as any,
  );

  return { listener, eventService, findUndescribedImagePreviews };
}

function sendsOf(eventService: { send: jest.Mock }, event: string) {
  return eventService.send.mock.calls.filter(([name]) => name === event);
}

describe('ImageDescriptionBackfillListener', () => {
  it('enqueues one description per candidate, keyed on the preview id', async () => {
    const { listener, eventService } = makeListener([candidates(3)]);

    await listener.handle({ userId: USER, limit: 500 });

    const sends = sendsOf(eventService, PreviewGeneratedEvent);

    expect(sends).toHaveLength(3);
    expect(sends[0]![1]).toEqual({ userId: USER, previewId: 'preview-0' });
    expect(sends[0]![2]).toMatchObject({ singletonKey: 'image-description:preview-0' });
  });

  // The whole point of paging: a 22,870-photo library used to get exactly one
  // page described and then nothing, because nothing asked for page two.
  it('chains the next page behind a full one, with the last original as the cursor', async () => {
    const { listener, eventService } = makeListener([candidates(2)]);

    await listener.handle({ userId: USER, limit: 2 });

    const [next] = sendsOf(eventService, ImageDescriptionBackfillRequestEvent);

    expect(next).toBeDefined();
    expect(next![1]).toEqual({ userId: USER, limit: 2, afterParentFileId: 'original-1' });
    // Keyed per cursor: the queue's `short` policy refuses a duplicate key,
    // and the user-only key would collide with this page's own request.
    expect(next![2]).toMatchObject({ singletonKey: `image-description-backfill:${USER}:original-1` });
  });

  it('passes the cursor it was given to the query', async () => {
    const { listener, findUndescribedImagePreviews } = makeListener([candidates(1, 7)]);

    await listener.handle({ userId: USER, limit: 2, afterParentFileId: 'original-6' });

    expect(findUndescribedImagePreviews).toHaveBeenCalledWith(USER, 2, 'original-6');
  });

  it('stops chaining on a short page', async () => {
    const { listener, eventService } = makeListener([candidates(1)]);

    await listener.handle({ userId: USER, limit: 2 });

    expect(sendsOf(eventService, ImageDescriptionBackfillRequestEvent)).toHaveLength(0);
  });

  it('sends nothing at all when there are no candidates', async () => {
    const { listener, eventService } = makeListener([[]]);

    await listener.handle({ userId: USER, limit: 2 });

    expect(eventService.send).not.toHaveBeenCalled();
  });
});
