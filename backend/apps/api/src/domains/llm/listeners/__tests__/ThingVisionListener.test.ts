import type { CreateObjectObservationDto, ObjectResolutionOutcome } from '@ci/domains/memory';

import { ThingVisionListener } from '../ThingVisionListener';

/**
 * `ThingVisionListener` — the successor to the retired inventory listener,
 * which `ci.object_observations` was introduced to fix. That listener "wrote
 * speculative ci.object rows straight from a vision guess", conflating
 * "a coffee mug is visible in this photo" with "I own this specific coffee
 * mug", and had no arbiter at all: re-uploading a photo multiplied the rows.
 *
 * What changed, and what deliberately did not:
 *
 *  - The minting STAYS. This listener only runs when the upload carried
 *    `thingCapture: true` — an explicit per-upload assertion by the user that
 *    they are cataloguing their own belongings. The intent to own is real; it
 *    is the model's item-by-item reading of the photo that is a guess.
 *  - The guess is now RECORDED, and the sighting is the ARBITER. Every item
 *    becomes a sighting first; the resolution ladder gets first refusal; only
 *    what it declines is minted, and the minted row is attached back to the
 *    sighting. Because the sighting is keyed on (file, detector, label), the
 *    second pass over the same photo finds it already resolved and mints
 *    nothing.
 *
 * These tests are the witness for the second half.
 */

const FILE = 'file-1';
const USER = 'user-1';

const ANALYSIS = JSON.stringify({
  items: [
    {
      name: 'Coffee Mug',
      description: 'White ceramic mug',
      category: 'Kitchenware',
      brand: null,
      model: null,
      condition: 'good',
      estimated_value: 8,
    },
    {
      name: 'Desk Lamp',
      description: 'Anglepoise-style lamp',
      category: 'Lighting',
      brand: 'IKEA',
      model: null,
      condition: 'fair',
      estimated_value: 25,
      colors: ['matte black'],
      materials: ['steel', 'plastic'],
      dimensions: '40 x 15 x 15 cm',
      mass: '1.2 kg',
    },
  ],
});

function makeListener(opts: { content?: string; externalCreatedAt?: Date | null } = {}) {
  const { content = ANALYSIS, externalCreatedAt = null } = opts;

  const fileService = {
    findById: jest.fn(async () => ({
      id: FILE,
      contentType: 'image/jpeg',
      key: 'key-1',
      createdAt: new Date('2026-05-01T09:00:00.000Z'),
      externalCreatedAt,
    })),
    getFileContent: jest.fn(async () => Buffer.from('pixels')),
  };

  const rendition = {
    render: jest.fn(async () => ({ jpeg: Buffer.from('pixels'), source: 'original' as const })),
  };
  const ollamaService = {
    resolveModel: jest.fn(async (_ctx: unknown, opts?: { requestedModel?: string | null }) => ({
      model: opts?.requestedModel?.trim() ? opts.requestedModel : 'Qwen3-8B',
      enableThinking: false,
      enableTools: false,
    })),
    chat: jest.fn(async () => ({ message: { content } })),
  };

  const itemService = {
    create: jest.fn(async (_ctx: unknown, dto: { name: string }) => ({
      id: `item-${dto.name.replace(/\s+/g, '-').toLowerCase()}`,
      name: dto.name,
    })),
  };

  const observationService = {
    create: jest.fn(
      async (
        _ctx: unknown,
        dto: CreateObjectObservationDto,
      ): Promise<{ id: string; resolvedObjectId: string | null } | null> => ({
        id: `obs-${dto.label.replace(/\s+/g, '-').toLowerCase()}`,
        resolvedObjectId: null,
      }),
    ),
    resolve: jest.fn(async () => ({})),
  };

  // Declines by default: the ladder answering "no match" is what leaves the
  // mint path reachable, and it is the common case for a first capture.
  const declined: ObjectResolutionOutcome = {
    observationId: 'obs-1',
    method: 'none',
    confidence: null,
    objectId: null,
    productId: null,
    reason: 'no rung matched',
    applied: false,
    observation: null,
  };

  const resolutionService = {
    resolveAndApply: jest.fn(async (): Promise<ObjectResolutionOutcome> => declined),
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const imageDescriptionPreference = {
    isEnabled: jest.fn(async () => true),
  };

  const listener = new ThingVisionListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ollamaService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    itemService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    observationService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolutionService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    imageDescriptionPreference as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rendition as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return {
    listener,
    fileService,
    ollamaService,
    itemService,
    observationService,
    resolutionService,
    imageDescriptionPreference,
    logger,
  };
}

function upload(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    fileId: FILE,
    thingCapture: true,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('ThingVisionListener — a vision guess is recorded as a sighting', () => {
  it('skips quietly when image description is disabled', async () => {
    const { listener, imageDescriptionPreference, ollamaService, observationService } = makeListener();
    imageDescriptionPreference.isEnabled.mockResolvedValueOnce(false);

    await listener.handleFileUploaded(upload());

    expect(ollamaService.chat).not.toHaveBeenCalled();
    expect(observationService.create).not.toHaveBeenCalled();
  });

  it('records one sighting per identified item', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    expect(observationService.create).toHaveBeenCalledTimes(2);
    expect(observationService.create.mock.calls.map((call) => call[1].label)).toEqual([
      'Coffee Mug',
      'Desk Lamp',
    ]);
  });

  it('records the sighting BEFORE minting the owned unit', async () => {
    const { listener, observationService, itemService } = makeListener();

    const order: string[] = [];

    observationService.create.mockImplementation(async (_ctx: unknown, dto: CreateObjectObservationDto) => {
      order.push(`observe:${dto.label}`);

      return { id: `obs-${dto.label}`, resolvedObjectId: null };
    });
    itemService.create.mockImplementation(async (_ctx: unknown, dto: { name: string }) => {
      order.push(`mint:${dto.name}`);

      return { id: `item-${dto.name}`, name: dto.name };
    });

    await listener.handleFileUploaded(upload());

    // The weak claim is on the record before the strong one is made, so a crash
    // between them leaves a sighting with no owner rather than an owned unit
    // with no evidence.
    expect(order[0]).toBe('observe:Coffee Mug');
    expect(order[1]).toBe('mint:Coffee Mug');
  });

  it('attaches the minted unit to the sighting as a resolution', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    expect(observationService.resolve).toHaveBeenCalledWith(
      expect.anything(),
      'obs-coffee-mug',
      // `label` is the honest method: nothing matched an identifier or an
      // embedding, the model read a name off a photo.
      { resolvedObjectId: 'item-coffee-mug', resolutionMethod: 'label', resolutionConfidence: null },
    );
  });

  it('NEVER invents a detection confidence', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    // The prompt asks for no score. A number made up here would outrank a
    // genuinely measured one later.
    expect(observationService.create.mock.calls[0][1].detectionConfidence).toBeNull();
  });

  it('names the model as the detector, so the sighting says who spoke', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload({ model: 'llava:13b' }));

    expect(observationService.create.mock.calls[0][1]).toEqual(
      expect.objectContaining({ labelSource: 'ollama_vision', detector: 'llava:13b', fileId: FILE }),
    );
  });

  it('carries the observed state into attributes', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    // The migration's own example for this column is
    // `{color: 'red', condition: 'scratched', count: 2}` — colour included.
    expect(observationService.create.mock.calls[1][1].attributes).toEqual({
      condition: 'fair',
      category: 'Lighting',
      colors: ['matte black'],
      materials: ['steel', 'plastic'],
    });
  });

  it('records the detector’s words verbatim, without normalizing them', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    const { attributes } = observationService.create.mock.calls[1][1];

    // Dimensions and mass are unit-bearing strings that only mean anything
    // once `normalizePhysicalProperties` has resolved them onto ci.objects.
    // A raw second copy on the sighting is a second thing to parse and
    // disagree about, so it is left off rather than half-recorded.
    expect(attributes).not.toHaveProperty('dimensions');
    expect(attributes).not.toHaveProperty('mass');
  });

  it('omits colours and materials the model did not report', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    // The first fixture item has neither; absent beats an empty array, which
    // would read as "looked, saw none".
    const { attributes } = observationService.create.mock.calls[0][1];

    expect(attributes).not.toHaveProperty('colors');
    expect(attributes).not.toHaveProperty('materials');
  });

  it('dates the sighting from the capture time, not the time the job ran', async () => {
    const { listener, observationService } = makeListener({
      externalCreatedAt: new Date('2018-03-09T08:00:00.000Z'),
    });

    await listener.handleFileUploaded(upload());

    expect(observationService.create.mock.calls[0][1].observedAt).toEqual(
      new Date('2018-03-09T08:00:00.000Z'),
    );
  });

  it('falls back to the upload time when there is no capture time', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    expect(observationService.create.mock.calls[0][1].observedAt).toEqual(
      new Date('2026-05-01T09:00:00.000Z'),
    );
  });

  it('sets no resolution on the way in — that is a separate call', async () => {
    const { listener, observationService } = makeListener();

    await listener.handleFileUploaded(upload());

    const dto = observationService.create.mock.calls[0][1];

    expect(dto).not.toHaveProperty('resolvedObjectId');
    expect(dto).not.toHaveProperty('resolutionMethod');
    expect(dto).not.toHaveProperty('confirmedByUser');
  });

  it('mints nothing when the sighting matched a human-confirmed row', async () => {
    const { listener, observationService, itemService } = makeListener();

    // `create` returns null when the row is protected. That row's resolution
    // belongs to the person who made it — minting anyway would hand them a
    // second copy of the thing they already answered about.
    observationService.create.mockResolvedValue(null);

    await listener.handleFileUploaded(upload());

    expect(itemService.create).not.toHaveBeenCalled();
    expect(observationService.resolve).not.toHaveBeenCalled();
  });

  it('mints nothing on a re-upload — the sighting already points at a thing', async () => {
    const { listener, observationService, itemService, resolutionService } = makeListener();

    // What `createMany` returns the SECOND time: the same row, keyed on
    // (file, detector, label), with the resolution columns it was given on the
    // first pass left untouched. This is the row multiplication the retired
    // inventory listener had no defence against.
    observationService.create.mockImplementation(async (_ctx: unknown, dto: CreateObjectObservationDto) => ({
      id: `obs-${dto.label}`,
      resolvedObjectId: `item-${dto.label}`,
    }));

    await listener.handleFileUploaded(upload());

    expect(itemService.create).not.toHaveBeenCalled();
    expect(resolutionService.resolveAndApply).not.toHaveBeenCalled();
    expect(observationService.resolve).not.toHaveBeenCalled();
  });

  it('links to an existing thing the ladder matched instead of minting a second one', async () => {
    const { listener, itemService, observationService, resolutionService } = makeListener();

    resolutionService.resolveAndApply.mockResolvedValue({
      observationId: 'obs-coffee-mug',
      method: 'identifier',
      confidence: 0.95,
      objectId: 'already-owned-mug',
      productId: null,
      reason: 'gtin matched one unit',
      applied: true,
      observation: null,
    });

    await listener.handleFileUploaded(upload());

    // The whole point: the mug is already in the user's things, so the photo
    // adds evidence, not a duplicate.
    expect(itemService.create).not.toHaveBeenCalled();
    expect(observationService.resolve).not.toHaveBeenCalled();
  });

  it('gives the ladder first refusal before minting anything', async () => {
    const { listener, resolutionService, itemService } = makeListener();

    const order: string[] = [];

    resolutionService.resolveAndApply.mockImplementation(async () => {
      order.push('resolve');

      return {
        observationId: 'obs-1',
        method: 'none',
        confidence: null,
        objectId: null,
        productId: null,
        reason: 'no rung matched',
        applied: false,
        observation: null,
      };
    });
    itemService.create.mockImplementation(async (_ctx: unknown, dto: { name: string }) => {
      order.push('mint');

      return { id: `item-${dto.name}`, name: dto.name };
    });

    await listener.handleFileUploaded(upload());

    expect(order.slice(0, 2)).toEqual(['resolve', 'mint']);
  });

  it('does nothing at all without the explicit thing-capture opt-in', async () => {
    const { listener, observationService, itemService, fileService } = makeListener();

    await listener.handleFileUploaded(upload({ thingCapture: false }));

    // The user's assertion of ownership is what makes minting legitimate; with
    // no assertion there is no capture at all, and so no sighting either.
    expect(fileService.findById).not.toHaveBeenCalled();
    expect(observationService.create).not.toHaveBeenCalled();
    expect(itemService.create).not.toHaveBeenCalled();
  });

  it('records nothing when the model finds nothing', async () => {
    const { listener, observationService, itemService } = makeListener({
      content: JSON.stringify({ items: [] }),
    });

    await listener.handleFileUploaded(upload());

    expect(observationService.create).not.toHaveBeenCalled();
    expect(itemService.create).not.toHaveBeenCalled();
  });

  it('records nothing when the model returns unparseable output', async () => {
    const { listener, observationService, itemService } = makeListener({
      content: 'I am afraid I cannot do that.',
    });

    await listener.handleFileUploaded(upload());

    expect(observationService.create).not.toHaveBeenCalled();
    expect(itemService.create).not.toHaveBeenCalled();
  });
});
