import { z } from 'zod';

/** Keep in sync with frontend `components/selectors/types.ts`. */
export const SELECTOR_TYPES = [
  'yes_no',
  'yes_no_not_sure',
  'keep_discard',
  'approve_edit',
  'segmented_truth',
  'pick_a_face',
  'radio_list',
  'checklist',
  'tag_cloud',
  'a_b',
  'feeling_grid',
  'person_find',
  'one_line',
  'paragraph',
  'guided_write',
  'sentence_stem',
  'intensity_1_5',
  'privacy_slider',
  'drag_rank',
  'day_chips',
  'trip_window',
  'preset_scope',
  'recurrence',
  'activity_scrub',
  'deep_work',
  'person_picker',
  'attendees',
  'relationship',
  'drop_pin',
  'venue_list',
  'home_work_other',
  'what_did_you_do_here',
  'pick_images',
  'crop_focus',
  'media_moment',
  'tap_hub',
  'connection_type',
  'pick_a_day',
  'source_of_truth',
  'accept_slot',
  'accept_edits',
] as const;

export type SelectorType = (typeof SELECTOR_TYPES)[number];

/**
 * Selectors the generate job may emit. Catalog types that need images, maps,
 * or calendar payloads stay in the component library but are not first-ship.
 */
export const GENERATABLE_SELECTOR_TYPES = [
  'yes_no',
  'yes_no_not_sure',
  'keep_discard',
  'segmented_truth',
  'radio_list',
  'checklist',
  'tag_cloud',
  'a_b',
  'feeling_grid',
  'one_line',
  'paragraph',
  'sentence_stem',
  'intensity_1_5',
  'day_chips',
  'recurrence',
  'person_picker',
  'relationship',
  'home_work_other',
  'what_did_you_do_here',
  'connection_type',
  'accept_slot',
  'pick_a_day',
] as const;

export type GeneratableSelectorType = (typeof GENERATABLE_SELECTOR_TYPES)[number];

export const DEFAULT_SELECTOR_OPTIONS: Partial<Record<SelectorType, Array<{ id: string; label: string }>>> = {
  yes_no: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  feeling_grid: [
    { id: 'happy', label: 'Happy' },
    { id: 'calm', label: 'Calm' },
    { id: 'tired', label: 'Tired' },
    { id: 'stressed', label: 'Stressed' },
    { id: 'excited', label: 'Excited' },
    { id: 'sad', label: 'Sad' },
    { id: 'focused', label: 'Focused' },
    { id: 'anxious', label: 'Anxious' },
    { id: 'content', label: 'Content' },
  ],
  relationship: [
    { id: 'friend', label: 'Friend' },
    { id: 'family', label: 'Family' },
    { id: 'colleague', label: 'Colleague' },
    { id: 'partner', label: 'Partner' },
    { id: 'acquaintance', label: 'Acquaintance' },
    { id: 'neighbor', label: 'Neighbor' },
    { id: 'other', label: 'Other' },
  ],
  connection_type: [
    { id: 'KNOWS', label: 'Knows' },
    { id: 'INTERESTED_IN', label: 'Interested in' },
    { id: 'LIVES_AT', label: 'Lives at' },
    { id: 'WORKS_AT', label: 'Works at' },
    { id: 'RELATED_TO', label: 'Related to' },
  ],
  what_did_you_do_here: [
    { id: 'live', label: 'Live here' },
    { id: 'work', label: 'Work here' },
    { id: 'visit', label: 'Visit' },
    { id: 'eat', label: 'Eat / drink' },
    { id: 'exercise', label: 'Exercise' },
    { id: 'shop', label: 'Shop' },
    { id: 'other', label: 'Other' },
  ],
  recurrence: [
    { id: 'daily', label: 'Daily' },
    { id: 'weekdays', label: 'Weekdays' },
    { id: 'weekly', label: 'Weekly' },
    { id: 'monthly', label: 'Monthly' },
    { id: 'rarely', label: 'Rarely' },
  ],
  accept_slot: [],
  pick_a_day: [],
};

const CHOICE_SELECTOR_TYPES = new Set<SelectorType>([
  'radio_list',
  'checklist',
  'tag_cloud',
  'a_b',
  'feeling_grid',
  'relationship',
  'what_did_you_do_here',
  'connection_type',
  'person_picker',
  'accept_slot',
  'pick_a_day',
]);

export function selectorNeedsOptions(type: SelectorType): boolean {
  return CHOICE_SELECTOR_TYPES.has(type);
}

export const CONTEXT_PROMPT_STATUSES = ['pending', 'answered', 'skipped', 'written', 'failed'] as const;
export type ContextPromptStatus = (typeof CONTEXT_PROMPT_STATUSES)[number];

export const SelectorOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
});

export const SelectorSpecSchema = z.object({
  type: z.enum(SELECTOR_TYPES),
  prompt: z.string().min(1).max(400),
  hint: z.string().max(400).optional(),
  options: z.array(SelectorOptionSchema).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  stem: z.string().optional(),
  scaffold: z.string().optional(),
  images: z.array(z.object({ id: z.string(), url: z.string(), label: z.string().optional() })).optional(),
  nodes: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  center: z.object({ lat: z.number(), lng: z.number() }).optional(),
});

export type SelectorSpec = z.infer<typeof SelectorSpecSchema>;

export const CONTEXT_PROMPT_PLACES = ['future_this_week', 'last_night', 'further_back'] as const;

export type ContextPromptPlace = (typeof CONTEXT_PROMPT_PLACES)[number];

export const ContextPromptSourceSchema = z.object({
  kind: z.enum(['answer', 'question', 'entity', 'category_gap', 'event', 'candidate']),
  id: z.string().optional(),
  label: z.string().optional(),
  /** Local calendar day `YYYY-MM-DD` when this prompt is offering a specific date. */
  day: z.string().optional(),
  place: z.enum(CONTEXT_PROMPT_PLACES).optional(),
});

export type ContextPromptSource = z.infer<typeof ContextPromptSourceSchema>;

export const CONTEXT_PROMPT_WRITERS = [
  'write_answer',
  'write_graph_entity',
  'write_graph_relationship',
  'write_person_properties',
  'write_place_properties',
  'write_inferred_fact',
  'write_event_actual',
  'write_schedule_accept',
  'skip_write',
] as const;

export type ContextPromptWriter = (typeof CONTEXT_PROMPT_WRITERS)[number];

export const ContextPromptWritePlanSchema = z.object({
  writer: z.enum(CONTEXT_PROMPT_WRITERS),
  properties: z.record(z.string(), z.unknown()).default({}),
  entityType: z.string().optional(),
  name: z.string().optional(),
  relationshipType: z.string().optional(),
  questionId: z.string().optional(),
  entityId: z.string().optional(),
  fromEntityId: z.string().optional(),
  toEntityId: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  durationMinutes: z.number().optional(),
  title: z.string().optional(),
  category: z.string().optional(),
  events: z
    .array(
      z.object({
        title: z.string().min(1),
        startTime: z.string().optional(),
        durationMinutes: z.number().optional(),
        category: z.string().optional(),
      }),
    )
    .optional(),
});

export type ContextPromptWritePlan = z.infer<typeof ContextPromptWritePlanSchema>;

/** vLLM and small models often wrap JSON in prose; take the first object. */
export function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }

    throw new Error(`LLM did not return JSON: ${content.slice(0, 80)}`);
  }
}
