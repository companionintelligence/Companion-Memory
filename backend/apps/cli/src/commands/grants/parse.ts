import { type CliContext, CliError } from '../../context';
import { json } from '../../output';
import {
  DISCLOSURE_RUNGS,
  describeGrantee,
  requireSuccess,
  resolveGrantee,
  type DisclosureRungFlag,
  type GrantModeFlag,
} from '../memoryShared';

export interface ParsedCliGrant {
  grantee: string;
  queryType: 'relationship' | 'content' | 'availability' | 'attribute' | 'identity';
  dataClass?: string;
  mode: GrantModeFlag;
  maxDisclosure?: DisclosureRungFlag;
  expiresAt?: string;
}

export interface GrantsParseOptions {
  apply?: boolean;
  json?: boolean;
}

const DATA_CLASS_MAP: Readonly<
  Record<
    string,
    {
      queryType: ParsedCliGrant['queryType'];
      dataClass: string;
    }
  >
> = {
  photos: { queryType: 'content', dataClass: 'photos' },
  photo: { queryType: 'content', dataClass: 'photos' },
  pictures: { queryType: 'content', dataClass: 'photos' },
  files: { queryType: 'content', dataClass: 'files' },
  documents: { queryType: 'content', dataClass: 'documents' },
  notes: { queryType: 'content', dataClass: 'notes' },
  messages: { queryType: 'content', dataClass: 'messages' },
  emails: { queryType: 'content', dataClass: 'emails' },
  availability: { queryType: 'availability', dataClass: 'calendar' },
  calendar: { queryType: 'availability', dataClass: 'calendar' },
  schedule: { queryType: 'availability', dataClass: 'calendar' },
  contacts: { queryType: 'relationship', dataClass: 'contacts' },
  relationships: { queryType: 'relationship', dataClass: 'contacts' },
  friends: { queryType: 'relationship', dataClass: 'contacts' },
  location: { queryType: 'attribute', dataClass: 'location' },
  places: { queryType: 'attribute', dataClass: 'location' },
  health: { queryType: 'attribute', dataClass: 'health' },
  medical: { queryType: 'attribute', dataClass: 'medical' },
  finance: { queryType: 'attribute', dataClass: 'finance' },
  financial: { queryType: 'attribute', dataClass: 'financial' },
  identity: { queryType: 'identity', dataClass: 'identity' },
};

/**
 * Parse a natural-language consent sentence (`open-instinct` pattern) into
 * structured standing-grant parameters.
 */
export function parseGrantSentence(sentence: string, now: Date = new Date()): ParsedCliGrant {
  const text = sentence.trim().replace(/\s+/g, ' ');
  if (!text) {
    throw new CliError('Grant sentence must not be empty.');
  }

  let mode: GrantModeFlag = 'review';
  if (/^(?:block|deny|forbid|disallow|prevent|never\s+let|never\s+allow)\b/i.test(text)) {
    mode = 'block';
  } else if (/^(?:review|ask\s+me\s+(?:first|before)|require\s+review)\b/i.test(text)) {
    mode = 'review';
  } else if (/^(?:allow|let|permit|grant|auto[- ]?allow|auto[- ]?answer)\b/i.test(text)) {
    mode = 'auto';
  }

  const handleMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  let grantee = handleMatch?.[1] ?? '';

  if (!grantee) {
    const verbMatch = text.match(
      /^(?:allow|let|permit|grant|block|deny|forbid|disallow|prevent|review|ask\s+me\s+(?:first|before)\s+for)\s+(?:asks\s+from\s+|user\s+|peer\s+)?([a-zA-Z0-9_.-]+)/i,
    );
    grantee = verbMatch?.[1] ?? '';
  }

  if (!grantee) {
    throw new CliError('Could not identify a grantee handle or user ID in the sentence.');
  }

  const lower = text.toLowerCase();
  let queryType: ParsedCliGrant['queryType'] = 'content';
  let dataClass: string | undefined;

  for (const [keyword, mapping] of Object.entries(DATA_CLASS_MAP)) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(lower)) {
      queryType = mapping.queryType;
      dataClass = mapping.dataClass;
      break;
    }
  }

  let maxDisclosure: DisclosureRungFlag | undefined;
  if (mode === 'block') {
    maxDisclosure = 'none';
  } else {
    for (const rung of DISCLOSURE_RUNGS) {
      if (
        new RegExp(
          `\\b(?:at\\s+most\\s+${rung}|${rung}\\s+(?:only|disclosure|ceiling|level)|max(?:imum)?\\s+disclosure\\s+${rung})\\b`,
          'i',
        ).test(lower)
      ) {
        maxDisclosure = rung;
        break;
      }
    }
  }

  let expiresAt: string | undefined;
  const durationMatch = lower.match(/\bfor\s+(\d+)\s*(hour|hours|hr|hrs|day|days|week|weeks)\b/i);
  if (durationMatch) {
    const amount = Number.parseInt(durationMatch[1], 10);
    const unit = durationMatch[2].toLowerCase();
    const multiplierMs = unit.startsWith('h') ? 3600_000 : unit.startsWith('w') ? 7 * 86_400_000 : 86_400_000;
    expiresAt = new Date(now.getTime() + amount * multiplierMs).toISOString();
  } else if (/\bthis\s+week\b/i.test(lower)) {
    expiresAt = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  } else if (/\b(?:today|tonight|for\s+a\s+day)\b/i.test(lower)) {
    expiresAt = new Date(now.getTime() + 86_400_000).toISOString();
  }

  return {
    grantee,
    queryType,
    ...(dataClass ? { dataClass } : {}),
    mode,
    ...(maxDisclosure ? { maxDisclosure } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * `ci grants parse <sentence>` — parse a natural-language consent instruction
 * into a structured grant (and optionally create it on the appliance with `--apply`).
 */
export async function grantsParseCommand(
  ctx: CliContext,
  sentence: string,
  options: GrantsParseOptions = {},
): Promise<void> {
  const parsed = parseGrantSentence(sentence);

  if (!options.apply) {
    if (options.json) {
      json(ctx.term, parsed);

      return;
    }

    ctx.term.out(
      `Parsed grant: grantee=${parsed.grantee} queryType=${parsed.queryType}` +
        (parsed.dataClass ? ` dataClass=${parsed.dataClass}` : '') +
        ` mode=${parsed.mode}` +
        (parsed.maxDisclosure ? ` maxDisclosure=${parsed.maxDisclosure}` : '') +
        (parsed.expiresAt ? ` expiresAt=${parsed.expiresAt}` : ''),
    );

    return;
  }

  const granteeTarget = await resolveGrantee(ctx, parsed.grantee);
  const { grant } = requireSuccess(
    await ctx.graphql.createAskGrant({
      ...granteeTarget,
      queryType: parsed.queryType,
      dataClass: parsed.dataClass,
      mode: parsed.mode,
      maxDisclosure: parsed.maxDisclosure,
    }),
  );

  if (options.json) {
    json(ctx.term, { parsed, grant });

    return;
  }

  ctx.term.out(
    `Created grant ${grant?.id} — ${grant ? describeGrantee(grant) : parsed.grantee} ` +
      `may ask "${parsed.queryType}", mode ${grant?.mode}.`,
  );
}
