/**
 * "Life details" on Self — a fixed, hand-curated slice of the Reflections
 * catalogue (not new Person schema), picked question-by-question rather than
 * "whatever a category filter returns first": a generic category fetch
 * surfaced low-value trivia ("Are you colorblind?", "Are you registered as an
 * organ donor?") ahead of anything worth having on a profile.
 *
 * Questions are named by `ci.questions.question_key`, NOT by question_id.
 * That is not a style preference — ids here were a bug. `question_id`
 * defaults to `gen_uuid_v7()`, so the seed migration mints a different uuid
 * on every appliance it runs on; a list of ids captured from the machine
 * this feature was built on matched nothing anywhere else, and because the
 * questions themselves are hardcoded below, the grid rendered them anyway
 * while every answer read and write resolved to no row. The section looked
 * permanently blank, with no error, on every install but one. A key is
 * written by the migration that seeds the question and means the same thing
 * on every database.
 *
 * Each key here MUST be seeded by
 * backend/apps/api/db/postgres/migrations/20260824234643_seed_life_details_question_keys.sql.
 * `lifeDetails.catalogue.node.test.ts` parses that migration and fails if
 * this file names a key it does not seed, or disagrees with it about a
 * question's text, category, type or tier — so a curated question added on
 * one side and forgotten on the other is a red test, not a blank section.
 *
 * `text`/`category`/`questionType`/`tier` are baked in here rather than
 * re-fetched — the only thing that can change server-side for a fixed
 * question is whether it's been answered, so the one network call this module
 * builds asks for exactly that (see `curatedCatalogueUrl`). Trade-off, stated
 * plainly: if a question's phrasing is edited server-side, this list shows
 * the old wording until someone updates it here — acceptable for a fixed,
 * hand-picked list that isn't expected to drift, same as any other
 * hard-coded UI copy.
 *
 * Kept apart from the component so the curated list and query-building stay
 * unit-testable without a renderer.
 */
import type { CatalogueAnswer, CatalogueEntry } from '@/pages/PromptsPage/catalogue';

export type LifeDetailQuestionType = 'open_ended' | 'yes_no' | 'multiple_choice';
export type LifeDetailAnswerTier = 'factual' | 'preference' | 'narrative';

export interface CuratedQuestion {
  /**
   * `ci.questions.question_key`. Stable across appliances, unlike the row's
   * uuid — see the module comment for what using the uuid cost.
   */
  key: string;
  text: string;
  /** `ci.questions.question_category` — provenance only, not used to fetch. */
  category: string;
  questionType: LifeDetailQuestionType;
  tier: LifeDetailAnswerTier;
  /**
   * Button labels, posted verbatim as the answer text when clicked. Present
   * for every `yes_no` question and for the `multiple_choice` ones whose
   * options are unambiguous, low-stakes lifestyle picks (season, cat/dog,
   * beach/mountains…). Deliberately absent for the two identity-flavored
   * `multiple_choice` questions (pronouns, relationship status): the
   * catalogue itself defines no real option list for `multiple_choice`
   * (there is no schema for it), so any button set here would be this UI's
   * own invention — fine for "beach or mountains", not something to impose
   * on how someone describes their pronouns or relationship. Those two stay
   * free text.
   */
  options?: string[];
}

export interface LifeDetailTheme {
  /** This grid's own grouping id — unrelated to `CuratedQuestion.key`, which is a database column. */
  key: string;
  label: string;
  questions: CuratedQuestion[];
}

export const LIFE_DETAIL_THEMES: LifeDetailTheme[] = [
  {
    key: 'health',
    label: 'Health',
    questions: [
      {
        key: 'blood_type',
        text: 'What is your blood type?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'food_allergies',
        text: 'What foods are you allergic to?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'medication_allergies',
        text: 'Are you allergic to any medications?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'chronic_conditions',
        text: 'What chronic conditions have you been diagnosed with?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'regular_medications',
        text: 'What medications do you take regularly?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'family_health_conditions',
        text: 'Which health conditions run in your immediate family?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
    ],
  },
  {
    key: 'body',
    label: 'Body',
    questions: [
      {
        key: 'height',
        text: 'How tall are you?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'weight',
        text: 'What is your current weight?',
        category: 'Health & Body',
        questionType: 'open_ended',
        tier: 'factual',
      },
    ],
  },
  {
    key: 'identity',
    label: 'Identity & Background',
    // Ordered low-stakes/factual first, most personal last — pronouns before
    // orientation, not the reverse.
    questions: [
      {
        key: 'pronouns',
        text: 'What pronouns do you use?',
        category: 'Identity & Background',
        questionType: 'multiple_choice',
        tier: 'factual',
      },
      {
        key: 'spoken_languages',
        text: 'What languages do you speak?',
        category: 'Identity & Background',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'cultural_background',
        text: 'What cultural or ethnic background does your family identify with?',
        category: 'Identity & Background',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'religion_or_spiritual_practice',
        text: 'What is your religion or spiritual practice now, if any?',
        category: 'Identity & Background',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'relationship_status',
        text: 'What is your relationship status?',
        category: 'Identity & Background',
        questionType: 'multiple_choice',
        tier: 'factual',
      },
      {
        key: 'sexual_orientation',
        text: 'How would you describe your sexual orientation?',
        category: 'Identity & Background',
        questionType: 'open_ended',
        tier: 'preference',
      },
    ],
  },
  {
    key: 'lifePreferences',
    label: 'Preferences',
    questions: [
      {
        key: 'morning_person_or_night_owl',
        text: 'Are you a morning person or a night owl?',
        category: 'Preferences & Favorites',
        questionType: 'multiple_choice',
        tier: 'preference',
        options: ['Morning person', 'Night owl'],
      },
      {
        key: 'favorite_season',
        text: 'What is your favorite season?',
        category: 'Preferences & Favorites',
        questionType: 'multiple_choice',
        tier: 'preference',
        options: ['Spring', 'Summer', 'Fall', 'Winter'],
      },
      {
        key: 'cat_or_dog_person',
        text: 'Are you more of a cat person or a dog person?',
        category: 'Preferences & Favorites',
        questionType: 'multiple_choice',
        tier: 'preference',
        options: ['Cat person', 'Dog person'],
      },
      {
        key: 'beach_or_mountains',
        text: 'Do you prefer the beach or the mountains?',
        category: 'Preferences & Favorites',
        questionType: 'multiple_choice',
        tier: 'preference',
        options: ['Beach', 'Mountains'],
      },
      {
        key: 'cook_or_order_in',
        text: 'Do you prefer to cook or to order in?',
        category: 'Preferences & Favorites',
        questionType: 'multiple_choice',
        tier: 'preference',
        options: ['Cook', 'Order in'],
      },
      {
        key: 'favorite_cuisine',
        text: 'What is your favorite cuisine?',
        category: 'Preferences & Favorites',
        questionType: 'open_ended',
        tier: 'preference',
      },
      {
        key: 'food_never_eaten',
        text: 'What food will you not eat under any circumstances?',
        category: 'Preferences & Favorites',
        questionType: 'open_ended',
        tier: 'factual',
      },
    ],
  },
  {
    key: 'interests',
    label: 'Interests & Culture',
    // Just one narrative "tell me about your hobby" prompt, not two asking
    // the same thing from slightly different angles.
    questions: [
      {
        key: 'longest_hobby',
        text: 'Which hobby have you kept the longest, and for how many years?',
        category: 'Interests & Culture',
        questionType: 'open_ended',
        tier: 'narrative',
      },
      {
        key: 'skill_in_progress',
        text: 'What skill are you trying to get better at this year?',
        category: 'Interests & Culture',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'volunteering',
        text: 'Do you volunteer for any organization?',
        category: 'Interests & Culture',
        questionType: 'yes_no',
        tier: 'factual',
        options: ['Yes', 'No'],
      },
      {
        key: 'languages_learning',
        text: 'Which languages are you learning, if any?',
        category: 'Interests & Culture',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'sports_followed',
        text: 'What sports do you follow?',
        category: 'Interests & Culture',
        questionType: 'open_ended',
        tier: 'factual',
      },
    ],
  },
  {
    key: 'homeTown',
    label: 'Home Town',
    // Birth city and childhood city are distinct facts (many people move as
    // kids); one narrative prompt anchors the rest rather than three that all
    // fish at "tell me about growing up" from slightly different angles.
    questions: [
      {
        key: 'birth_city',
        text: 'What city were you born in?',
        category: 'Places & Travel',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'childhood_city',
        text: 'In which city did you spend most of your childhood?',
        category: 'Places & Travel',
        questionType: 'open_ended',
        tier: 'factual',
      },
      {
        key: 'childhood_home_memory',
        text: 'What do you remember most about the home you grew up in?',
        category: 'Home & Daily Life',
        questionType: 'open_ended',
        tier: 'narrative',
      },
    ],
  },
];

/** Every curated question across every theme, in a fixed flat order. */
export function curatedQuestions(): CuratedQuestion[] {
  return LIFE_DETAIL_THEMES.flatMap((theme) => theme.questions);
}

/** Every curated key across every theme, in a fixed flat order. */
export function curatedQuestionKeys(): string[] {
  return curatedQuestions().map((question) => question.key);
}

/**
 * Factual Home Town answers used as a Map starting point. Childhood city first
 * — that is closer to "home" than birth city when they differ. The narrative
 * prompt is not a place name.
 *
 * Keys, for the reason in the module comment: these arrived on `main` as the
 * two matching uuids, which name nothing on any appliance but the one they
 * were copied from — the Map would simply never find a home city anywhere
 * else, as silently as the grid rendered blank.
 */
export const HOME_TOWN_CITY_QUESTION_KEYS = ['childhood_city', 'birth_city'] as const;

/** Childhood + birth city only — the Map home camera does not need the rest of Self. */
export function homeTownCatalogueUrl(): string {
  const keys = [...HOME_TOWN_CITY_QUESTION_KEYS];
  const params = new URLSearchParams({
    keys: keys.join(','),
    status: 'active',
    answered: 'all',
    limit: String(keys.length),
  });

  return `/api/questions/catalogue?${params.toString()}`;
}

/**
 * One combined fetch for the whole section: every curated question's current
 * answer, in a single round trip. `limit` is set to the key count explicitly —
 * the endpoint's default (25) would silently truncate this set.
 */
export function curatedCatalogueUrl(): string {
  const keys = curatedQuestionKeys();
  const params = new URLSearchParams({
    keys: keys.join(','),
    status: 'active',
    answered: 'all',
    limit: String(keys.length),
  });

  return `/api/questions/catalogue?${params.toString()}`;
}

/**
 * What the catalogue returned for one curated key: the question_id to answer
 * against (minted per appliance, so it is only ever read from the response,
 * never hardcoded) and the current answer, if any.
 */
export interface CuratedCatalogueRow {
  id: string;
  answer: CatalogueAnswer | null;
}

/** Keyed by `question_key`, for the curated keys the catalogue actually knows. */
export type CuratedAnswers = Record<string, CuratedCatalogueRow>;

/**
 * Index a catalogue page by curated key, and report which curated keys the
 * catalogue had nothing for.
 *
 * A missing key means the seed migration never ran, or a question was added to
 * the list above without one — the exact condition that used to blank this
 * section in silence. It is returned rather than swallowed so the caller can
 * say so out loud and refuse to render an input that would discard what gets
 * typed into it.
 */
export function indexCuratedAnswers(entries: readonly CatalogueEntry[]): {
  byKey: CuratedAnswers;
  missingKeys: string[];
} {
  const byKey: CuratedAnswers = {};

  for (const entry of entries) {
    if (entry.key) {
      byKey[entry.key] = { id: entry.id, answer: entry.answer };
    }
  }

  return { byKey, missingKeys: curatedQuestionKeys().filter((key) => !(key in byKey)) };
}
