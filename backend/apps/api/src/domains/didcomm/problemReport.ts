import { DidcommError } from './errors';
import { createMessage, type DidcommMessage } from './message';

/**
 * Problem Reports 2.0 (https://didcomm.org/report-problem/2.0): the standard way to tell another
 * party that something went wrong, and how much of the interaction to undo.
 *
 * A code is `sorter.scope.descriptor[.descriptor…]` in lower kebab-case: sorter `e` (error) or `w`
 * (warning, consequences unclear); scope `p` (abandon the protocol), `m` (reject this one message)
 * or a state name; descriptors from general to specific (`trust.crypto`, `did`, `msg`, `xfer`, `me`,
 * `req.time`…). Receivers may match on a prefix. `comment` is static text tied to the code, with
 * `{1}`, `{2}` filled from `args`, so a report never carries free-form detail from the failure.
 */

export const PROBLEM_REPORT_TYPE = 'https://didcomm.org/report-problem/2.0/problem-report';

const TOKEN = '[a-z0-9]+(?:[-_][a-z0-9]+)*';
const PROBLEM_CODE = new RegExp(`^[ew]\\.${TOKEN}(?:\\.${TOKEN})+$`);

export function isProblemCode(code: unknown): code is string {
  return typeof code === 'string' && code.length <= 256 && PROBLEM_CODE.test(code);
}

export interface ProblemReportInput {
  code: string;
  /** Static text for this code, with `{1}`-style placeholders. */
  comment?: string;
  args?: string[];
  /** The thread the problem occurred in (REQUIRED by the protocol). */
  pthid: string;
  /** Ids of messages that triggered the problem. */
  ack?: string[];
  escalateTo?: string;
  from?: string;
  to?: string[];
}

export function buildProblemReport(input: ProblemReportInput, now?: number): DidcommMessage {
  if (!isProblemCode(input.code)) {
    throw new DidcommError(
      'invalid-argument',
      `"${input.code}" is not a problem code (sorter.scope.descriptor)`,
    );
  }

  return createMessage(
    {
      type: PROBLEM_REPORT_TYPE,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      pthid: input.pthid,
      body: {
        code: input.code,
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        ...(input.args !== undefined ? { args: input.args } : {}),
        ...(input.escalateTo !== undefined ? { escalate_to: input.escalateTo } : {}),
      },
      headers: input.ack !== undefined ? { ack: input.ack } : undefined,
    },
    now,
  );
}

/**
 * Fills `{1}`, `{2}`… in a comment. A missing or null argument becomes `?`; arguments the comment
 * has no placeholder for are appended as comma-separated values (both rules are in the protocol).
 */
export function interpolateComment(comment: string, args: Array<string | null | undefined> = []): string {
  const used = new Set<number>();
  const filled = comment.replace(/\{(\d+)\}/g, (_match, digits: string) => {
    const position = Number(digits);

    used.add(position);

    return args[position - 1] ?? '?';
  });

  const extra = args.filter((_value, index) => !used.has(index + 1)).map((value) => value ?? '?');

  return extra.length > 0 ? `${filled} ${extra.join(', ')}` : filled;
}

export interface ParsedProblemReport {
  code: string;
  comment?: string;
  args: string[];
  escalateTo?: string;
  /** The thread the problem occurred in. */
  pthid?: string;
}

export function parseProblemReport(message: DidcommMessage): ParsedProblemReport {
  if (message.type !== PROBLEM_REPORT_TYPE) {
    throw new DidcommError('invalid-argument', 'not a problem report');
  }

  const { code, comment, args, escalate_to: escalateTo } = message.body ?? {};

  if (!isProblemCode(code)) {
    throw new DidcommError('malformed-message', 'problem report has no valid "code"');
  }

  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
    throw new DidcommError('malformed-message', 'problem report "args" must be an array of strings');
  }

  return {
    code,
    comment: typeof comment === 'string' ? comment : undefined,
    args: (args as string[] | undefined) ?? [],
    escalateTo: typeof escalateTo === 'string' ? escalateTo : undefined,
    pthid: message.pthid,
  };
}
