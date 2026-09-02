import type { DispatchPacket, DispatchTurn, PacketMode } from './entities/AgentJobEntity';

const STOP_RULES = [
  'You are OpenClaw executing a Memory dispatch. Memory owns the task and this job.',
  'Fetch nothing extra from Memory to start — this packet is the briefing.',
  'Stop and report blocked if you fail the same step twice, or if you need the user.',
  'Destructive work goes through pending_actions. Your connect key is write, never full.',
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
          'Use CI Memory intents (`/api/agent/intents`) for recall, writes, and planning updates.',
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
