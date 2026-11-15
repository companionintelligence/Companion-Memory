/**
 * Deterministic System-1 L0 behavioral classifier for `ci.tasks.l0_class`.
 *
 * Maps a task's title, description, and notes onto HBPE's canonical 8-class L0
 * vocabulary (`backend/apps/hbpe/src/ci/hbpe/model/vocab.py`: `WORK`,
 * `EXERCISE`, `SOCIAL`, `ERRAND`, `LEISURE`, `TRANSIT`, `SLEEP`, `UNKNOWN`) so
 * completed tasks (`get_completed_tasks_for_day` in `data_client.py`) and
 * proposed-task schedule candidates carry a valid `l0_class` without requiring
 * a synchronous LLM round-trip on task write paths.
 */

export const TASK_L0_CLASSES = [
  'WORK',
  'EXERCISE',
  'SOCIAL',
  'ERRAND',
  'LEISURE',
  'TRANSIT',
  'SLEEP',
  'UNKNOWN',
] as const;

export type TaskL0Class = (typeof TASK_L0_CLASSES)[number];

const L0_PATTERNS: ReadonlyArray<{ l0: Exclude<TaskL0Class, 'UNKNOWN'>; patterns: readonly RegExp[] }> = [
  {
    l0: 'EXERCISE',
    patterns: [
      /\b(workout|gym|fitness|cardio|pilates|crossfit|yoga|stretch(?:ing)?|swim(?:ming)?|cycling|biking|tennis|pickleball|hike|hiking|jog(?:ging)?|marathon|5k|10k|peloton|weightlifting|pushups|pullups)\b/i,
      /\b(morning\s+run|go\s+for\s+a\s+run|run\s+\d+\s*(?:km|mi|miles))\b/i,
    ],
  },
  {
    l0: 'TRANSIT',
    patterns: [
      /\b(flight|airport|airlines?|boarding\s+pass|train|amtrak|caltrain|bart|subway|commute|uber|lyft|taxi|carpool|road\s+trip|red-?eye)\b/i,
      /\b(drive\s+to|pick\s+up\s+from\s+airport|book\s+(?:flight|train|shuttle))\b/i,
    ],
  },
  {
    l0: 'SLEEP',
    patterns: [/\b(sleep|nap|power\s+nap|bedtime|wind\s+down\s+for\s+bed|lights\s+out)\b/i],
  },
  {
    l0: 'SOCIAL',
    patterns: [
      /\b(dinner\s+with|lunch\s+with|coffee\s+with|drinks\s+with|brunch\s+with|catch\s+up\s+with|hangout|happy\s+hour|birthday\s+party|anniversary|wedding|date\s+night|game\s+night|potluck|reunion|celebration|visit\s+(?:mom|dad|family|friends|parents))\b/i,
      /\b(call\s+(?:mom|dad|grandma|grandpa|sister|brother)|text\s+back|rsvp)\b/i,
    ],
  },
  {
    l0: 'ERRAND',
    patterns: [
      /\b(grocer(?:y|ies)|supermarket|trader\s+joe'?s|whole\s+foods|costco|safeway|target|walmart|pharmacy|walgreens|cvs|prescription|refill|dentist|doctor|dermatologist|optometrist|vet(?:erinarian)?|pediatrician|physical\s+therapy|dmv|passport|renew(?:al)?|bank|deposit|tax(?:es)?|invoice|bill|rent|mortgage|insurance|laundry|dry\s+clean(?:ing|er)?|post\s+office|ups|fedex|usps|return\s+package|oil\s+change|car\s+wash|hardware\s+store|haircut|barber|plumber|electrician|handyman|clean\s+(?:the\s+)?(?:kitchen|bathroom|house|apartment|garage|fridge))\b/i,
      /\b(buy\s+(?:milk|eggs|bread|groceries|supplies|gift|tickets)|pick\s+up\s+(?:rx|prescription|dry\s+cleaning|groceries|package)|schedule\s+(?:appointment|checkup|cleaning)|pay\s+(?:bill|invoice|rent|taxes|utilities))\b/i,
    ],
  },
  {
    l0: 'LEISURE',
    patterns: [
      /\b(movie|cinema|theater|concert|museum|exhibition|gallery|festival|show|netflix|podcast|novel|read\s+(?:book|chapter)|video\s+games?|gaming|guitar|piano|painting|gardening|knitting|bake|baking|vacation|holiday|sightseeing|beach|camping)\b/i,
    ],
  },
  {
    l0: 'WORK',
    patterns: [
      /\b(meeting|standup|sync|1:1|one-on-one|sprint|roadmap|retro(?:spective)?|postmortem|interview|onboarding|presentation|slide\s+deck|pitch\s+deck|quarterly|okr|kpi|milestone|deliverable|client|stakeholder|vendor|contract|proposal|memo|rfc|design\s+doc|architecture|code\s+review|pull\s+request|merge\s+request|deploy(?:ment)?|release|migration|refactor|bug\s*fix|unit\s+tests?|benchmark|ci\/cd|incident|on-?call|pager|backlog|jira|linear|github|pr\s+#?\d+|ship\s+the)\b/i,
      /\b(write\s+(?:the\s+)?(?:migration|spec|docs|documentation|report|tests|code|pr)|review\s+(?:pr|pull\s+request|spec|design|proposal|deck)|prepare\s+(?:slides|deck|agenda|brief)|send\s+(?:status\s+update|follow-?up\s+email|weekly\s+report))\b/i,
    ],
  },
];

export function isTaskL0Class(value: unknown): value is TaskL0Class {
  return typeof value === 'string' && (TASK_L0_CLASSES as readonly string[]).includes(value);
}

/**
 * Classify a task into one of HBPE's 8 `L0_CLASSES`.
 *
 * Title matches carry weight 2; description/notes matches carry weight 1 so a
 * specific title ("Dentist appointment") wins over incidental context in notes
 * ("after my work meeting"). Returns `'UNKNOWN'` when no domain pattern matches.
 */
export function classifyTaskL0(
  title: string,
  description?: string | null,
  notes?: string | null,
): TaskL0Class {
  const cleanTitle = (title ?? '').trim();
  const cleanSecondary = [description ?? '', notes ?? ''].join(' ').trim();

  if (!cleanTitle && !cleanSecondary) {
    return 'UNKNOWN';
  }

  let bestClass: TaskL0Class = 'UNKNOWN';
  let bestScore = 0;

  for (const { l0, patterns } of L0_PATTERNS) {
    let score = 0;

    for (const pattern of patterns) {
      if (cleanTitle && pattern.test(cleanTitle)) {
        score += 2;
      }

      if (cleanSecondary && pattern.test(cleanSecondary)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestClass = l0;
    }
  }

  return bestClass;
}
