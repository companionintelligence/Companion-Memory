/** Catalog selector ids — keep in sync with backend `SELECTOR_TYPES`. */
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

const SUBMIT_ON_SELECT = new Set<SelectorType>(['yes_no', 'yes_no_not_sure']);

export function selectorSubmitsOnSelect(type: SelectorType): boolean {
  return SUBMIT_ON_SELECT.has(type);
}

export interface SelectorOption {
  id: string;
  label: string;
  description?: string;
  imageUrl?: string;
}

export interface SelectorMediaItem {
  id: string;
  url: string;
  label?: string;
}

export interface SelectorNode {
  id: string;
  label: string;
}

export interface SelectorSpec {
  type: SelectorType;
  prompt: string;
  hint?: string;
  options?: SelectorOption[];
  min?: number;
  max?: number;
  stem?: string;
  scaffold?: string;
  images?: SelectorMediaItem[];
  nodes?: SelectorNode[];
  center?: { lat: number; lng: number };
}

export type SelectorValue =
  | string
  | number
  | string[]
  | { lat: number; lng: number }
  | { x: number; y: number }
  | { start: number; end: number }
  | Record<string, unknown>
  | null;
