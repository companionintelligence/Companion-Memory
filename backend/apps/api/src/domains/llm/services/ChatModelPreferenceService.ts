import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { type UserServiceContext } from '@ci/common/context';
import { PersonService, UserContextService, ensureSelfEntityId } from '@ci/domains/memory';

const CACHE_TTL_MS = 60_000;

export interface MemoryGovernancePreferences {
  /** Whether automatic fact supersession & conflict tracking (`knowl` pattern) is enabled. Defaults true. */
  memoryGovernanceEnabled: boolean;
  /** Whether exponential temporal recency decay in hybrid recall is enabled. Defaults true. */
  memoryRecencyDecayEnabled: boolean;
}

export interface DecisionEnginePreferences {
  /** Whether the Contrastive ("System 1", `CLM` pattern) fast decision layer is enabled. Defaults true. */
  contrastiveDecisionEnabled: boolean;
  /** Whether the Generative ("System 2") LLM decision / fallback layer is enabled. Defaults true. */
  generativeDecisionEnabled: boolean;
}

interface ChatModelPreferences extends MemoryGovernancePreferences, DecisionEnginePreferences {
  /** The user's override, or `null` when they have never set one. */
  chatModel: string | null;
  /** Whether tool calling is enabled for this user's chat turns. Defaults true. */
  toolsEnabled: boolean;
  /** Whether extended thinking is enabled for this user's chat turns. Defaults true. */
  thinkingEnabled: boolean;
}

/**
 * Settings → Model: which chat model a user talks to, and their Tools /
 * Thinking toggles. Stored on the self person's `properties.planner`
 * (`chat_model`, `tools_enabled`, `thinking_enabled`) — the same bag
 * {@link ImageDescriptionPreferenceService} and PersonalizationService's
 * `trust_mode` already live in.
 *
 * Before this, all three were `localStorage` in the browser (`useModel.ts`):
 * they reset on a cleared profile or a new device, and a background job
 * (image description, thing vision) had no way to ask "which model does this
 * user actually want" — `OllamaService` fell back to a single appliance-wide
 * constant (`PROMPT_MODEL`, i.e. `llm.chatModel`) for everyone. `getChatModel`
 * returns the raw override — `null` means "no override", and the caller
 * (`OllamaService`) applies the `PROMPT_MODEL` fallback, so this service does
 * not need to import LlmCore and risk the cycle {@link
 * ImageDescriptionPreferenceService} already documents.
 *
 * `chatModel: null` is a real, settable state — not just "never touched" —
 * because a user who has picked a model over Settings should be able to say
 * "go back to whatever the appliance defaults to" without hand-typing it.
 */
@Injectable()
export class ChatModelPreferenceService {
  private readonly cache = new Map<string, { prefs: ChatModelPreferences; expiresAt: number }>();

  constructor(
    private readonly personService: PersonService,
    private readonly userContextService: UserContextService,
    /**
     * For `SELF_ENTITY_PROVISIONER`, resolved lazily by `ensureSelfEntityId` —
     * see its doc for why it cannot be injected. Optional so a hand-built service
     * (the unit tests) still constructs; without it a user who has no self entity
     * gets the old error rather than a new one.
     */
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  async getChatModel(userId: string): Promise<string | null> {
    return (await this.getPreferences(userId)).chatModel;
  }

  async getToolsEnabled(userId: string): Promise<boolean> {
    return (await this.getPreferences(userId)).toolsEnabled;
  }

  async getThinkingEnabled(userId: string): Promise<boolean> {
    return (await this.getPreferences(userId)).thinkingEnabled;
  }

  async getMemoryGovernancePreferences(userId: string): Promise<MemoryGovernancePreferences> {
    const prefs = await this.getPreferences(userId);

    return {
      memoryGovernanceEnabled: prefs.memoryGovernanceEnabled,
      memoryRecencyDecayEnabled: prefs.memoryRecencyDecayEnabled,
    };
  }

  async getDecisionEnginePreferences(userId: string): Promise<DecisionEnginePreferences> {
    const prefs = await this.getPreferences(userId);

    return {
      contrastiveDecisionEnabled: prefs.contrastiveDecisionEnabled,
      generativeDecisionEnabled: prefs.generativeDecisionEnabled,
    };
  }

  async setChatModel(context: UserServiceContext, model: string | null): Promise<string | null> {
    const trimmed = model?.trim() || null;

    await this.writeLeaf(context, 'chat_model', trimmed);

    return trimmed;
  }

  async setToolsEnabled(context: UserServiceContext, enabled: boolean): Promise<boolean> {
    await this.writeLeaf(context, 'tools_enabled', enabled);

    return enabled;
  }

  async setThinkingEnabled(context: UserServiceContext, enabled: boolean): Promise<boolean> {
    await this.writeLeaf(context, 'thinking_enabled', enabled);

    return enabled;
  }

  async setMemoryGovernanceEnabled(context: UserServiceContext, enabled: boolean): Promise<boolean> {
    await this.writeLeaf(context, 'memory_governance_enabled', enabled);

    return enabled;
  }

  async setMemoryRecencyDecayEnabled(context: UserServiceContext, enabled: boolean): Promise<boolean> {
    await this.writeLeaf(context, 'memory_recency_decay_enabled', enabled);

    return enabled;
  }

  async setContrastiveDecisionEnabled(context: UserServiceContext, enabled: boolean): Promise<boolean> {
    await this.writeLeaf(context, 'contrastive_decision_enabled', enabled);

    return enabled;
  }

  async setGenerativeDecisionEnabled(context: UserServiceContext, enabled: boolean): Promise<boolean> {
    await this.writeLeaf(context, 'generative_decision_enabled', enabled);

    return enabled;
  }

  private async writeLeaf(
    context: UserServiceContext,
    leaf:
      | 'chat_model'
      | 'tools_enabled'
      | 'thinking_enabled'
      | 'memory_governance_enabled'
      | 'memory_recency_decay_enabled'
      | 'contrastive_decision_enabled'
      | 'generative_decision_enabled',
    value: string | boolean | null,
  ): Promise<void> {
    const userId = context.userId!;
    // Provisioned when the user has none: an imported account has no self entity
    // to store the preference on, and picking a model answered 500 for it.
    const selfEntityId = await ensureSelfEntityId(context, this.userContextService, this.moduleRef);

    // A single-leaf write, like ImageDescriptionPreferenceService — never a
    // rebuilt `planner` object, which would clobber trust_mode or the other
    // two preferences this service itself owns if a concurrent write lands
    // between our read and our write.
    await this.personService.patchPropertyLeaves(context, selfEntityId, [
      { path: ['planner', leaf], value },
      { path: ['planner', 'source'], value: 'settings' },
    ]);

    this.invalidate(userId);
  }

  private async getPreferences(userId: string): Promise<ChatModelPreferences> {
    const cached = this.cache.get(userId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.prefs;
    }

    const prefs = await this.readPreferences(userId);

    this.cache.set(userId, { prefs, expiresAt: Date.now() + CACHE_TTL_MS });

    return prefs;
  }

  private async readPreferences(userId: string): Promise<ChatModelPreferences> {
    const selfIdentity = await this.userContextService.getSelfIdentity(userId);

    if (!selfIdentity) {
      return {
        chatModel: null,
        toolsEnabled: true,
        thinkingEnabled: true,
        memoryGovernanceEnabled: true,
        memoryRecencyDecayEnabled: true,
        contrastiveDecisionEnabled: true,
        generativeDecisionEnabled: true,
      };
    }

    const context = { userId } as UserServiceContext;
    const self = await this.personService.findById(context, selfIdentity.entityId);
    const planner = (self?.properties?.planner ?? {}) as Record<string, unknown>;
    const chatModel =
      typeof planner.chat_model === 'string' && planner.chat_model.trim() ? planner.chat_model : null;

    return {
      chatModel,
      toolsEnabled: planner.tools_enabled !== false,
      thinkingEnabled: planner.thinking_enabled !== false,
      memoryGovernanceEnabled: planner.memory_governance_enabled !== false,
      memoryRecencyDecayEnabled: planner.memory_recency_decay_enabled !== false,
      contrastiveDecisionEnabled: planner.contrastive_decision_enabled !== false,
      generativeDecisionEnabled: planner.generative_decision_enabled !== false,
    };
  }
}
