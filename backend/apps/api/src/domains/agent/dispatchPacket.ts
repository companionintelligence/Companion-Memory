import type { DispatchPacket, DispatchTurn, PacketMode } from './entities/AgentJobEntity';

const STOP_RULES = [
  'You are OpenClaw executing a Memory dispatch. Memory owns the task and this job.',
  'Fetch nothing extra from Memory to start — this packet is the briefing.',
  'Stop and report blocked if you fail the same step twice, or if you need the user.',
  // WAS: "Your connect key is write, never full." That became false the moment
  // the managed-app gate landed — `capabilityForApp` mints ci-openclaw at FULL
  // precisely so a destructive intent becomes an approval card instead of a flat
  // 403. Briefing the harness that it holds only `write` makes a capable model
  // route AROUND the very action the gate exists to intercept, or read the
  // TOOL_QUEUED 200 as a failure and retry into duplicate cards. The packet is
  // the harness's only in-band statement of its own authority, so it has to be
  // the true one.
  'A destructive intent is not refused, it is QUEUED: the call returns TOOL_QUEUED with error.details.pendingActionId and does NOT perform the action — your owner is asked to confirm it.',
  'Never re-issue a queued call to check on it. That queues a SECOND card. Report blocked, name the pendingActionId, and stop.',
  'Push checkpoints to Memory. Do not expect Memory to pull your session store.',
].join(' ');

export function buildDispatchPacket(input: {
  jobId: string;
  threadId: string;
  taskId?: string | null;
  mode?: PacketMode;
  title: string;
  body?: string | null;
  sourceKind: string;
  sourceId: string;
  ask?: string | null;
}): DispatchPacket {
  const mode: PacketMode = input.mode ?? 'both';
  const details = [
    `Title: ${input.title}`,
    input.body?.trim() ? `Context:\n${input.body.trim()}` : null,
    `Source: ${input.sourceKind} ${input.sourceId}`,
    input.taskId ? `Task: ${input.taskId}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n\n');

  const procedure =
    mode === 'details'
      ? 'Work from the context above. Use Memory intents only when you must write or look something up.'
      : [
          // Names the TOOLS first and the HTTP route second, because that is the
          // order of preference. The curated intents reach the harness as MCP
          // tools — OpenClaw renames every MCP tool to `<server>__<tool>`, so
          // `memory.recall` arrives as `ci-server__memory_recall`. A capable
          // model told only about a REST route will hand-roll HTTP calls and
          // lose the typed parameter schemas the intent catalog exists to give
          // it.
          'Prefer the typed `ci-server__*` Memory tools (e.g. `ci-server__memory_recall`) for recall, writes, and planning updates.',
          'If those tools are absent, fall back to POST `/api/agent/intents/<intent>/execute`.',
          'Queue destructive or external work as pending_actions.',
          'Checkpoint after each meaningful step so Memory can pair-program.',
        ].join(' ');

  const ask = input.ask?.trim() || `Do this: ${input.title}`;

  const turns: DispatchTurn[] = [
    { role: 'system', content: STOP_RULES },
    { role: 'user', content: mode === 'intents' ? `Job ${input.jobId}.` : details },
    { role: 'user', content: procedure },
    { role: 'user', content: ask },
  ];

  return {
    jobId: input.jobId,
    mode,
    turns,
    source: {
      kind: input.sourceKind,
      id: input.sourceId,
      title: input.title,
      body: input.body ?? null,
    },
    taskId: input.taskId ?? null,
    threadId: input.threadId,
  };
}
