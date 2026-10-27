import { Injectable } from '@nestjs/common';
import { z } from 'zod/v3';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { OnEvent } from '@ci/domains/events';
import { FileService, FileUploadedEvent, type FileUploadedPayload } from '@ci/domains/files';
import {
  ItemService,
  ObjectObservationService,
  ObjectResolutionService,
  type ObjectCondition,
  type PhysicalItemPropertiesDto,
  normalizePhysicalProperties,
} from '@ci/domains/memory';

import { THING_VISION_QUEUE, THING_VISION_QUEUE_OPTIONS } from '../constants';
import { ImageDescriptionPreferenceService } from '../services/ImageDescriptionPreferenceService';
import { OllamaService } from '../services/OllamaService';
import { VisionRenditionService } from '../services/VisionRenditionService';
import { isNonMultimodalModelError } from '../visionErrors';

const ItemAnalysisSchema = z.object({
  name: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  condition: z.string().nullable(),
  estimated_value: z.number(),
  // Physical properties, as a model actually reports them: unit-bearing
  // strings. They are NOT converted here — ItemService resolves every unit
  // through the one normalizer, so this listener never learns what an inch is.
  colors: z.array(z.string()).nullable().optional(),
  materials: z.array(z.string()).nullable().optional(),
  dimensions: z.string().nullable().optional(),
  mass: z.string().nullable().optional(),
});

const AnalysisResponseSchema = z.object({
  items: z.array(ItemAnalysisSchema),
});

type ItemAnalysis = z.infer<typeof ItemAnalysisSchema>;

const PROMPT = `
  Analyze this image and identify all distinct objects visible.
  You are a JSON generator. Output ONLY valid JSON.
  Do not include any conversational text, markdown formatting, or explanations.

  If the image is too dark, blurry, or contains no distinct objects, return an empty array for "items".

  Return a JSON object with the following schema:
  {
    "items": [
      {
        "name": "Short name of the item",
        "description": "Brief description",
        "category": "General category (e.g., Electronics, Furniture, Tools)",
        "brand": "Brand name if visible, or null",
        "model": "Model if visible, or null",
        "condition": "Estimated condition (new, good, fair, poor)",
        "estimated_value": 0,
        "colors": ["Dominant colour first, plain names like navy or off-white"],
        "materials": ["What it appears to be made of, e.g. leather, oak, steel"],
        "dimensions": "Rough size as LxWxH WITH A UNIT, e.g. 30 x 20 x 5 cm — or null",
        "mass": "Rough weight WITH A UNIT, e.g. 1.2 kg — or null"
      }
    ]
  }

  For estimated_value, provide a rough number in USD based on visual condition. If unknown, use 0.

  Sizes and weights MUST carry their unit ("30 cm", not "30"). Omit any field you
  cannot see rather than guessing — a wrong measurement is worse than none.
`;

/** Matches the 'vision-guessed' tier documented on ci.objects.identity_confidence. */
const VISION_IDENTITY_CONFIDENCE = 0.4;

/**
 * `source_kind` for a photo the user deliberately shot to catalogue their
 * things. Distinguishes it from a passive frame in the observation timeline.
 */
const THING_CAPTURE_SOURCE_KIND = 'photo';

/** See the note on the identical helper in `CvDetectionsListener`. */
function parseExternalDate(value: Date | string | null | undefined): Date | null {
  if (value == null) {
    return null;
  }

  // Typed `Date | null` on FileEntity and genuinely a Date at runtime — the
  // column is `timestamptz` (`20260212130000_rebuild_files_table`) and the pg
  // driver parses it off the wire OID, whatever the entity's stale
  // `type: 'text'` decorator says. The string branch is kept because that
  // decorator means a raw query or a future writer could hand back text, and
  // the failure mode is `Invalid Date` in a NOT NULL column.
  const parsed = value instanceof Date ? value : new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Thing capture: the Ollama vision pass behind the camera's "thing" mode.
 *
 * ── What this replaced, and why the shape changed ──────────────────────────
 *
 * Its ancestor (`InventoryListener`, retired along with the standalone
 * inventory feature) minted one `ci.inventory` row per item the model read out
 * of the photo, unconditionally. It had no arbiter of any kind, so re-uploading the
 * same photo — or re-running the model over it — multiplied the user's
 * possessions: three passes over one desk photo produced three keyboards.
 *
 * The write order here is what fixes that, and it is deliberate:
 *
 *  1. THE SIGHTING FIRST. Every item the model reads becomes a
 *     `ci.object_observations` row keyed on (file, detector, label) — the
 *     `detectionKeyFor` scheme, chosen precisely because this pass returns no
 *     bounding boxes. Re-running the model over the same photo UPDATES each
 *     sighting in place, and two different objects in one frame stay two rows.
 *
 *  2. THE LADDER SECOND. {@link ObjectResolutionService.resolveAndApply} gets
 *     first refusal on every sighting. If the thing in the frame is already an
 *     owned unit — matched by identifier, embedding or place prior — the
 *     sighting links to THAT unit and nothing is minted. This is the case the
 *     old listener got wrong every single time.
 *
 *  3. MINTING LAST, AND ONLY ONCE. A sighting that resolved to nothing mints
 *     one unit, which is then attached to the sighting as its resolution.
 *     Because step 1 returns the SAME observation row on a re-upload, and
 *     because `createMany` never overwrites the resolution columns, that row
 *     comes back already carrying `resolvedObjectId` — so the second pass sees
 *     an answer and skips minting. The sighting is the idempotency key the old
 *     path never had.
 *
 * ── Why this mints at all ──────────────────────────────────────────────────
 *
 * {@link ObjectResolutionService} states, correctly, that a sighting is never
 * grounds for minting: "a coffee mug is visible in this photo" is not "I own
 * this coffee mug", and its ladder therefore only ever LINKS. That rule is
 * about MACHINE inference, and it is not relaxed here.
 *
 * This path has something the resolver does not: `thingCapture: true` on the
 * upload, an explicit per-upload assertion by the user that they are
 * photographing their own belongings (`FilesController` / `BulkFilesController`
 * read it off the form). The user's intent to own is stated; only the model's
 * item-by-item reading of the frame is a guess. So the guess is graded rather
 * than trusted — `identity_method: 'vision'` at
 * {@link VISION_IDENTITY_CONFIDENCE}, so a later barcode scan outranks it
 * instead of tying with it — and the whole chain from pixels to owned unit
 * stays queryable through the observation it hangs off.
 *
 * Passive frames, which carry no such assertion, go through
 * {@link CvDetectionsListener} and mint nothing.
 */
@Injectable()
export class ThingVisionListener {
  constructor(
    private readonly fileService: FileService,
    private readonly ollamaService: OllamaService,
    private readonly itemService: ItemService,
    private readonly observationService: ObjectObservationService,
    private readonly resolutionService: ObjectResolutionService,
    private readonly imageDescriptionPreference: ImageDescriptionPreferenceService,
    private readonly rendition: VisionRenditionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ThingVisionListener.name);
  }

  @OnEvent(FileUploadedEvent, { queue: THING_VISION_QUEUE, queueOptions: THING_VISION_QUEUE_OPTIONS })
  async handleFileUploaded(payload: FileUploadedPayload) {
    if (!payload.thingCapture) {
      this.logger.log('File uploaded without thing capture enabled, skipping processing', {
        fileId: payload.fileId,
      });

      return;
    }

    if (!(await this.imageDescriptionPreference.isEnabled(payload.userId))) {
      this.logger.log('Image description disabled — skipping thing vision', {
        fileId: payload.fileId,
        userId: payload.userId,
      });

      return;
    }

    const serviceContext = toServiceContext({
      userId: payload.userId,
    });

    const file = await this.fileService.findById(serviceContext, payload.fileId);

    if (file == null) {
      this.logger.warn('File not found, skipping processing', {
        fileId: payload.fileId,
      });

      return;
    }

    if (file.contentType == null || !file.contentType.startsWith('image/')) {
      this.logger.log('File is not an image, skipping processing', {
        fileId: payload.fileId,
        contentType: file.contentType,
      });

      return;
    }

    if (file.key == null) {
      this.logger.warn('File has no storage key, cannot retrieve content', {
        fileId: payload.fileId,
      });

      return;
    }

    // Same bounded rendition of the original the description pass uses; a
    // raw upload can be a 200 MP frame or a HEIC the model cannot read.
    const rendition = await this.rendition.render(serviceContext, file);

    if (rendition == null) {
      this.logger.warn('Image could not be rendered for thing vision, skipping', {
        fileId: payload.fileId,
        contentType: file.contentType,
      });

      return;
    }

    const messages = [
      {
        role: 'user' as const,
        content: PROMPT,
        images: [rendition.jpeg.toString('base64')],
      },
    ];

    // Same rule as ImageDescriptionListener: use a model the appliance is
    // actually serving, not a hard-coded vision tag that may not be pulled.
    const { model } = await this.ollamaService.resolveModel(serviceContext, {
      messages,
      requestedModel: payload.model,
    });

    this.logger.log('Starting LLM chat', {
      model,
    });

    let response;
    try {
      response = await this.ollamaService.chat(serviceContext, messages, {
        model,
        enableTools: false,
        format: 'json',
      });
    } catch (error) {
      if (isNonMultimodalModelError(error)) {
        this.logger.warn('Model cannot accept images — skipping thing vision gracefully', {
          model,
          fileId: payload.fileId,
          error: error instanceof Error ? error.message : String(error),
        });

        return;
      }

      throw error;
    }

    const content = response.message.content;

    this.logger.log('Raw LLM content received', {
      content,
    });

    const items = this.parseAndValidateAnalysis(content);

    if (items.length > 0) {
      this.logger.log('Identified items', {
        count: items.length,
      });
    }

    // The capture time of the pixels. `external_created_at` is TEXT and may be
    // anything an importer wrote, so it is parsed defensively and falls back to
    // the upload time.
    const observedAt = parseExternalDate(file.externalCreatedAt) ?? file.createdAt;

    for (const itemData of items) {
      const condition = itemData.condition?.toLowerCase() ?? 'good';
      const label = itemData.name?.trim() || 'Unknown Item';

      // THE SIGHTING, recorded before anything is minted.
      //
      // This pass returns a list of items with NO bounding boxes, which is
      // precisely the case `detectionKeyFor` picks its `label` scheme for: keyed
      // on (file, detector, label), so re-running the model over the same photo
      // updates each item in place, and two different objects in one frame stay
      // two rows instead of collapsing into one.
      const observation = await this.observationService.create(serviceContext, {
        observedAt,
        sourceKind: THING_CAPTURE_SOURCE_KIND,
        fileId: payload.fileId,
        label,
        labelSource: 'ollama_vision',
        detector: model,
        // No per-item score is available — the prompt does not ask for one, and
        // a number invented here would outrank a genuinely measured one later.
        detectionConfidence: null,
        // OBSERVED STATE, which is what this column is for — the migration's
        // own example is `{color: 'red', condition: 'scratched', count: 2}`.
        //
        // Recorded VERBATIM, exactly as `label` is, and deliberately NOT put
        // through `normalizePhysicalProperties`: that normalizer turns
        // unit-bearing strings into millimetres and grams for `ci.objects`,
        // and a sighting is the record of what the detector SAID, not of what
        // its words resolve to. Dimensions and mass are left off entirely for
        // the same reason — they need that normalizer to mean anything, and a
        // second raw copy here is a second thing to parse and disagree about.
        attributes: {
          ...(itemData.condition != null && { condition: itemData.condition }),
          ...(itemData.category != null && { category: itemData.category }),
          ...(itemData.colors != null && itemData.colors.length > 0 && { colors: itemData.colors }),
          ...(itemData.materials != null &&
            itemData.materials.length > 0 && { materials: itemData.materials }),
        },
        metadata: {
          thing_capture: true,
          original_analysis: itemData,
        },
      });

      // `create` returns null when the sighting matched a row a human has
      // already confirmed. That row's resolution is theirs; there is nothing
      // to add and nothing to log as a failure.
      if (observation == null) {
        continue;
      }

      // ALREADY ANSWERED. On a re-upload (or a second model pass over the same
      // photo) step 1 returns the SAME row — `createMany` keys it on
      // (file, detector, label) and never touches the resolution columns — so
      // this is where the old listener's row multiplication stops. Nothing is
      // minted for a sighting that already points at a unit.
      if (observation.resolvedObjectId != null) {
        this.logger.log('Sighting already resolved to a thing, not minting again', {
          observationId: observation.id,
          objectId: observation.resolvedObjectId,
        });

        continue;
      }

      // A PERSON SAID NO. "Not a thing" (`rejectObservation`) leaves the row
      // unconfirmed and unlinked under method `user`, so the check above lets
      // it through. Taking the same photo again must not undo that answer by
      // linking the sighting or minting a thing from it.
      if (observation.resolutionMethod === 'user') {
        this.logger.log('Sighting was answered by a person, not linking or minting', {
          observationId: observation.id,
        });

        continue;
      }

      // THE LADDER GETS FIRST REFUSAL. If the thing in frame is already an
      // owned unit — a barcode, an embedding, the place it lives — the sighting
      // links to that unit and this pass mints nothing.
      const resolved = await this.resolutionService.resolveAndApply(serviceContext, observation.id);

      // The row this pass read can be answered between `create` and here. The
      // ladder never produces method `user`, so an outcome carrying it means a
      // person got there first, and `applied: false` is not a decline to mint on.
      if (resolved?.method === 'user') {
        this.logger.log('Sighting was answered by a person mid-pass, not minting', {
          observationId: observation.id,
        });

        continue;
      }

      if (resolved?.applied === true) {
        this.logger.log('Sighting matched an existing thing, not minting', {
          observationId: observation.id,
          objectId: resolved.objectId,
          method: resolved.method,
          confidence: resolved.confidence,
        });

        continue;
      }

      const item = await this.itemService.create(serviceContext, {
        name: itemData.name || 'Unknown Item',
        description: itemData.description ?? undefined,
        category: itemData.category ?? undefined,
        brand: itemData.brand ?? undefined,
        model: itemData.model ?? undefined,
        condition: ['new', 'like_new', 'good', 'fair', 'poor', 'broken', 'n/a'].includes(condition)
          ? (condition as ObjectCondition)
          : 'good',
        currentValue: itemData.estimated_value,
        // A photo is not a tape measure. Saying so is the difference between a
        // guess a later barcode scan can overwrite and one that reads as fact —
        // the schema's 1.0 default would claim the latter.
        identityMethod: 'vision',
        identityConfidence: VISION_IDENTITY_CONFIDENCE,
        ...this.physicalPropertiesOf(itemData),
        metadata: {
          original_analysis: itemData,
          captured_at: new Date(),
          source_file_id: payload.fileId,
          source_observation_id: observation.id,
          // Measurement provenance, stamped at the write.
          // `identity_method` is the only other tell that these numbers were
          // eyeballed, and it is independently mutable: a later barcode scan
          // flips the row to 'barcode'/1.0 and the guessed millimetres would
          // read as ground truth ever after. This key survives that flip.
          measurements: {
            source: 'vision',
            model,
            at: new Date(),
          },
        },
      });

      this.logger.log('Thing minted from a capture photo', {
        itemId: item.id,
        name: item.name,
        observationId: observation.id,
      });

      // Attach the minted unit to the sighting it came from. `label` is the
      // honest method: nothing matched an identifier or an embedding, the model
      // read a name off a photo. Confidence is left unset rather than guessed.
      // This write is also what makes the NEXT pass a no-op.
      await this.observationService.resolve(serviceContext, observation.id, {
        resolvedObjectId: item.id,
        resolutionMethod: 'label',
        resolutionConfidence: null,
      });
    }

    this.logger.log('Thing capture processing completed');
  }

  /**
   * The physical half of a vision result, or nothing.
   *
   * Two rules, both because the writer is a model rather than a client:
   *
   * 1. `requireUnit`. The prompt asks for "30 x 20 x 5 cm"; a model that
   *    answers "30 x 20 x 5" is not saying millimetres, but that is how a bare
   *    number reads, and the CHECK constraints only guard the high side — a
   *    30 mm desk passes every one of them. A missing unit must lose the
   *    measurement, not silently shrink the object by 10x.
   * 2. The CANONICALIZED values are returned, not the model's strings, so the
   *    service's own (lenient, by design) normalization cannot re-admit what
   *    this stricter pass just rejected.
   *
   * An uninterpretable "medium-sized" therefore costs the measurement rather
   * than the whole item — the API rightly rejects the request instead, because
   * a client can fix a request and a model cannot.
   */
  private physicalPropertiesOf(analysis: ItemAnalysis): PhysicalItemPropertiesDto {
    const claimed = {
      colors: analysis.colors ?? undefined,
      materials: analysis.materials ?? undefined,
      dimensions: analysis.dimensions ?? undefined,
      massG: analysis.mass ?? undefined,
    };

    try {
      return normalizePhysicalProperties(claimed, { requireUnit: true });
    } catch (error) {
      this.logger.warn('Discarding unreadable physical properties from image analysis', {
        error: error instanceof Error ? error.message : String(error),
        colors: analysis.colors,
        materials: analysis.materials,
        dimensions: analysis.dimensions,
        mass: analysis.mass,
      });

      return {};
    }
  }

  private parseAndValidateAnalysis(content: string): ItemAnalysis[] {
    let jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();

    const firstOpen = jsonStr.indexOf('{');
    const lastClose = jsonStr.lastIndexOf('}');

    if (firstOpen !== -1 && lastClose !== -1) {
      jsonStr = jsonStr.substring(firstOpen, lastClose + 1);
    }

    try {
      const validationResult = AnalysisResponseSchema.safeParse(JSON.parse(jsonStr));

      if (!validationResult.success) {
        this.logger.error(validationResult.error, 'LLM response failed schema validation');

        return [];
      }

      return validationResult.data.items;
    } catch (error) {
      this.logger.error(error as Error, 'Failed to parse JSON from LLM response');

      return [];
    }
  }
}
