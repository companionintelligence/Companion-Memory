import type { LlmTask } from '../providers/LlmProvider';

/**
 * Plan 04 §3.2 — per-task routing preference. The router consults the policy
 * to decide which provider services a call and whether PII may egress.
 *
 * Defaults are deliberately conservative: embedding/classification/
 * consolidation stay local (Ollama); summarize/chat/reflect may use an
 * external model only with redaction; the user opts in per-task.
 */
export type ModelPreference = 'local' | 'high-quality' | 'balanced';

export type PiiEgress = 'never' | 'with-redaction' | 'allow';

export interface ModelPolicy {
  task: LlmTask;
  preference: ModelPreference;
  allowExternal: boolean;
  piiEgress: PiiEgress;
}

export const DEFAULT_MODEL_POLICIES: Record<LlmTask, ModelPolicy> = {
  embed: { task: 'embed', preference: 'local', allowExternal: false, piiEgress: 'never' },
  classify: { task: 'classify', preference: 'local', allowExternal: false, piiEgress: 'never' },
  summarize: { task: 'summarize', preference: 'balanced', allowExternal: true, piiEgress: 'with-redaction' },
  chat: { task: 'chat', preference: 'high-quality', allowExternal: true, piiEgress: 'with-redaction' },
  reflect: { task: 'reflect', preference: 'balanced', allowExternal: true, piiEgress: 'with-redaction' },
  consolidate: { task: 'consolidate', preference: 'local', allowExternal: false, piiEgress: 'never' },
};
