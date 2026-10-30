import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { type CliContext, CliError } from '../context';
import { json } from '../output';

export interface FleetSession {
  agentId: string;
  worktree: string;
  branch?: string;
  task?: string;
  claimedFiles: string[];
  updatedAt: string;
}

export interface FleetCollision {
  file: string;
  agents: string[];
}

export interface FleetState {
  sessions: FleetSession[];
}

export interface FleetRegisterOptions {
  worktree?: string;
  branch?: string;
  task?: string;
  files?: string[];
  stateFile?: string;
  json?: boolean;
}

export interface FleetStatusOptions {
  stateFile?: string;
  json?: boolean;
}

function resolveFleetStatePath(explicit?: string): string {
  return explicit ?? process.env.CI_FLEET_STATE_PATH ?? join(homedir(), '.ci', 'fleet.json');
}

function normalizeClaimPath(filePath: string): string {
  return filePath
    .trim()
    .replace(/^\.?\//, '')
    .replace(/\\/g, '/');
}

export function loadFleetState(statePath: string): FleetState {
  if (!existsSync(statePath)) {
    return { sessions: [] };
  }

  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<FleetState>;

    return {
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    };
  } catch {
    return { sessions: [] };
  }
}

export function saveFleetState(statePath: string, state: FleetState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function detectFleetCollisions(sessions: readonly FleetSession[]): FleetCollision[] {
  const byFile = new Map<string, Set<string>>();

  for (const session of sessions) {
    for (const rawFile of session.claimedFiles) {
      const file = normalizeClaimPath(rawFile);
      if (!file) {
        continue;
      }

      let holders = byFile.get(file);
      if (!holders) {
        holders = new Set<string>();
        byFile.set(file, holders);
      }

      holders.add(session.agentId);
    }
  }

  const collisions: FleetCollision[] = [];
  for (const [file, holders] of byFile.entries()) {
    if (holders.size > 1) {
      collisions.push({ file, agents: [...holders].sort() });
    }
  }

  return collisions.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * `ci fleet register <agentId>` — register or update an active agent session in
 * the multi-worktree fleet state (`knowl fleet` pattern) and report any
 * file-claim collisions with sibling agents.
 */
export async function fleetRegisterCommand(
  ctx: CliContext,
  agentId: string,
  options: FleetRegisterOptions = {},
): Promise<void> {
  const cleanId = agentId.trim();
  if (!cleanId) {
    throw new CliError('agentId must not be empty');
  }

  const statePath = resolveFleetStatePath(options.stateFile);
  const state = loadFleetState(statePath);
  const claimedFiles = [
    ...new Set((options.files ?? []).map(normalizeClaimPath).filter((f) => f.length > 0)),
  ];

  const existingIndex = state.sessions.findIndex((s) => s.agentId === cleanId);
  const session: FleetSession = {
    agentId: cleanId,
    worktree: options.worktree ?? process.cwd(),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.task ? { task: options.task } : {}),
    claimedFiles,
    updatedAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    state.sessions[existingIndex] = session;
  } else {
    state.sessions.push(session);
  }

  saveFleetState(statePath, state);
  const collisions = detectFleetCollisions(state.sessions).filter((c) => c.agents.includes(cleanId));

  if (options.json) {
    json(ctx.term, { session, collisions });

    return;
  }

  ctx.term.out(
    `Registered agent "${cleanId}" in ${session.worktree} (${claimedFiles.length} claimed file(s)).`,
  );
  if (collisions.length > 0) {
    for (const collision of collisions) {
      ctx.term.err(
        `[fleet collision] ${collision.file} is claimed by multiple agents: ${collision.agents.join(', ')}`,
      );
    }
  }
}

/**
 * `ci fleet claim <agentId> <files...>` — add claimed files to an agent session
 * and detect collisions with other active worktree agents.
 */
export async function fleetClaimCommand(
  ctx: CliContext,
  agentId: string,
  files: string[],
  options: FleetStatusOptions = {},
): Promise<void> {
  const cleanId = agentId.trim();
  if (!cleanId) {
    throw new CliError('agentId must not be empty');
  }

  const statePath = resolveFleetStatePath(options.stateFile);
  const state = loadFleetState(statePath);
  const incoming = files.map(normalizeClaimPath).filter((f) => f.length > 0);

  let session = state.sessions.find((s) => s.agentId === cleanId);
  if (!session) {
    session = {
      agentId: cleanId,
      worktree: process.cwd(),
      claimedFiles: [],
      updatedAt: new Date().toISOString(),
    };
    state.sessions.push(session);
  }

  session.claimedFiles = [...new Set([...session.claimedFiles, ...incoming])];
  session.updatedAt = new Date().toISOString();

  saveFleetState(statePath, state);
  const collisions = detectFleetCollisions(state.sessions).filter((c) => c.agents.includes(cleanId));

  if (options.json) {
    json(ctx.term, { session, collisions });

    return;
  }

  ctx.term.out(`Agent "${cleanId}" now claims ${session.claimedFiles.length} file(s).`);
  for (const collision of collisions) {
    ctx.term.err(
      `[fleet collision] ${collision.file} is claimed by multiple agents: ${collision.agents.join(', ')}`,
    );
  }
}

/**
 * `ci fleet release <agentId>` — release all claimed files and remove the
 * agent session from the active fleet registry.
 */
export async function fleetReleaseCommand(
  ctx: CliContext,
  agentId: string,
  options: FleetStatusOptions = {},
): Promise<void> {
  const cleanId = agentId.trim();
  const statePath = resolveFleetStatePath(options.stateFile);
  const state = loadFleetState(statePath);
  const before = state.sessions.length;
  state.sessions = state.sessions.filter((s) => s.agentId !== cleanId);
  const released = before !== state.sessions.length;
  saveFleetState(statePath, state);

  if (options.json) {
    json(ctx.term, { agentId: cleanId, released, activeSessions: state.sessions.length });

    return;
  }

  ctx.term.out(
    released ? `Released fleet session for "${cleanId}".` : `No active fleet session found for "${cleanId}".`,
  );
}

/**
 * `ci fleet status` — display all active worktree agent sessions and any
 * overlapping file claims across parallel agents.
 */
export async function fleetStatusCommand(ctx: CliContext, options: FleetStatusOptions = {}): Promise<void> {
  const statePath = resolveFleetStatePath(options.stateFile);
  const state = loadFleetState(statePath);
  const collisions = detectFleetCollisions(state.sessions);

  if (options.json) {
    json(ctx.term, {
      sessions: state.sessions,
      collisions,
    });

    return;
  }

  if (state.sessions.length === 0) {
    ctx.term.out('No active agent sessions in fleet.');

    return;
  }

  ctx.term.out(`Active fleet sessions (${state.sessions.length}):`);
  for (const s of state.sessions) {
    const taskPart = s.task ? ` — ${s.task}` : '';
    const filesPart = s.claimedFiles.length > 0 ? ` [${s.claimedFiles.join(', ')}]` : '';
    ctx.term.out(`  ${s.agentId} (${s.worktree})${taskPart}${filesPart}`);
  }

  if (collisions.length > 0) {
    ctx.term.out(`Collisions (${collisions.length}):`);
    for (const c of collisions) {
      ctx.term.out(`  ${c.file}: ${c.agents.join(', ')}`);
    }
  }
}
