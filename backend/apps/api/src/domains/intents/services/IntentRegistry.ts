import { Injectable } from '@nestjs/common';

import { INTENT_DOMAINS, isIntentDomain } from '../catalog/domains';
import { CI_ENTITIES } from '../catalog/entities';
import { INTENTS } from '../catalog/intents';
import {
  type CiEntityDescriptor,
  type IntentDefinition,
  type IntentDomain,
  type IntentManifest,
  type ManifestIntent,
  intentToolName,
} from '../types';

const MANIFEST_VERSION = '1.0.0';

/**
 * The in-memory source of truth for the CI Intent catalog. Validates the static
 * catalog at construction (fail-fast at boot) and serves lookups + the published
 * {@link IntentManifest}.
 *
 * Validation guarantees:
 * - intent names are unique and dotted (`domain.action`)
 * - every intent's `domain` is a registered schema domain
 * - the executable tool name (dots→underscores) is unique and MCP/OpenAI-safe
 */
@Injectable()
export class IntentRegistry {
  private readonly byName = new Map<string, IntentDefinition>();

  private readonly byToolName = new Map<string, IntentDefinition>();

  constructor() {
    this.validateAndIndex(INTENTS);
  }

  private validateAndIndex(intents: readonly IntentDefinition[]): void {
    const safeName = /^[a-zA-Z0-9_-]+$/;

    for (const intent of intents) {
      if (this.byName.has(intent.name)) {
        throw new Error(`Duplicate intent name: ${intent.name}`);
      }

      if (!isIntentDomain(intent.domain)) {
        throw new Error(`Intent ${intent.name} references unknown domain "${intent.domain}"`);
      }

      const parts = intent.name.split('.');
      if (parts.length !== 2 || parts[0] !== intent.domain || !parts[1]) {
        throw new Error(
          `Intent ${intent.name} must be named "${intent.domain}.<action>" to match its domain`,
        );
      }

      const tool = intentToolName(intent.name);
      if (!safeName.test(tool)) {
        throw new Error(`Intent ${intent.name} yields an unsafe tool name "${tool}"`);
      }

      if (this.byToolName.has(tool)) {
        throw new Error(`Intent tool-name collision: ${tool}`);
      }

      this.byName.set(intent.name, intent);
      this.byToolName.set(tool, intent);
    }
  }

  getIntents(): IntentDefinition[] {
    return [...this.byName.values()];
  }

  getDomains(): IntentDomain[] {
    return [...INTENT_DOMAINS];
  }

  getEntities(): CiEntityDescriptor[] {
    return [...CI_ENTITIES];
  }

  /** Look up an intent by its dotted name. */
  getIntent(name: string): IntentDefinition | undefined {
    return this.byName.get(name);
  }

  /** Look up an intent by its executable (underscored) tool name. */
  getIntentByToolName(tool: string): IntentDefinition | undefined {
    return this.byToolName.get(tool);
  }

  getIntentsByDomain(domain: string): IntentDefinition[] {
    return this.getIntents().filter((intent) => intent.domain === domain);
  }

  /**
   * The raw tool names that intents wrap (their `binding.tool`). These are the
   * tools an agent should reach via the curated intent instead of directly, so the
   * tool registry can demote them from the agent-facing list.
   */
  getSupersededToolNames(): string[] {
    return [...new Set(this.getIntents().map((intent) => intent.binding.tool))];
  }

  /**
   * The discoverable capability declaration (the published intent manifest).
   * `generatedAt` is supplied by the caller so this stays pure/deterministic.
   */
  buildManifest(generatedAt: string): IntentManifest {
    const intents: ManifestIntent[] = this.getIntents().map((intent) => ({
      name: intent.name,
      tool: intentToolName(intent.name),
      domain: intent.domain,
      title: intent.title,
      description: intent.description,
      parameters: intent.parameters,
      privacy: intent.privacy,
      consumes: intent.consumes ?? [],
      produces: intent.produces ?? [],
      phrases: intent.phrases ?? [],
    }));

    return {
      version: MANIFEST_VERSION,
      generatedAt,
      domains: this.getDomains(),
      entities: this.getEntities(),
      intents,
    };
  }
}
