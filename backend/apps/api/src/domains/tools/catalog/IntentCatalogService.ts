import { Injectable } from '@nestjs/common';

import type { ApiKeyCapability } from '@ci/common/decorators';

import { intentToolName } from '../core/types';
import { resolveDispatch, type DispatchTier } from '../policy/dispatchPolicy';
import { ToolRegistry } from '../registry/ToolRegistry';

import { INTENT_DOMAINS } from './domains';
import { CI_ENTITIES } from './entities';
import type { CiEntityDescriptor, IntentDomain, IntentManifest, ManifestIntent } from './types';

// 1.2.0 — added the optional per-intent `dispatch` ruling (and the echoed `tier`), populated only
// when the caller names a tier. Additive: a 1.1.0 client that never passes `tier` sees byte-identical
// output. The bump is so an on-device client can tell "this appliance computes rulings for me" from
// "this appliance is old enough that I must fall back to reading localCapable + privacy myself".
const MANIFEST_VERSION = '1.2.0';

/**
 * Public read API over the intent catalog — the single seam through which REST (the agent-domain
 * IntentsController), the MCP `intents://catalog` resource, and CI-Hub app registration read the
 * manifest. Every tool is an intent, so the catalog is built directly from the {@link ToolRegistry}
 * (each registered tool's schema is an IntentDefinition), overlaid with the domain + entity
 * vocabulary. Boot-time validation that each tool's domain is registered lives in
 * ToolsRegistrationService, right after the tools are loaded.
 */
@Injectable()
export class IntentCatalogService {
  constructor(private readonly tools: ToolRegistry) {}

  /**
   * The full discoverable capability declaration.
   *
   * Pass `options.tier` to have the server attach its own {@link resolveDispatch} ruling to every
   * intent. That is what the on-device tier should ask for: it turns "here are the inputs to the
   * rule" into "here is the rule's answer", so the phone branches on a decision instead of
   * carrying a second (and eventually third) implementation of the policy.
   *
   * `capability` narrows the ruling to a specific principal's authority; omitted, `resolveDispatch`
   * assumes full — the device owner acting as themselves, which is the on-device tier's normal case.
   *
   * `userId` is the caller. An intent that belongs to one account (the `messaging.*` intents
   * belong to whoever the BlueBubbles connector was set up for) is listed to that account only;
   * omitted, owned intents are left out, the same as for any caller who does not own them.
   */
  getManifest(
    options: { tier?: DispatchTier; capability?: ApiKeyCapability; userId?: string } = {},
  ): IntentManifest {
    const { tier, capability, userId } = options;

    const intents: ManifestIntent[] = this.tools.getOutboundCatalogTools({ userId }).map((schema) => ({
      name: schema.name,
      tool: intentToolName(schema.name),
      domain: schema.domain,
      title: schema.title,
      description: schema.description,
      parameters: schema.parameters,
      privacy: schema.privacy,
      // No `?? false` fallback: the field is required on IntentDefinition precisely so the
      // manifest never has to guess, and a silent `false` here would publish "not available
      // offline" for an intent whose author simply forgot to label it.
      localCapable: schema.localCapable,
      consumes: schema.consumes ?? [],
      produces: schema.produces ?? [],
      phrases: schema.phrases ?? [],
      // Only when asked. Without a tier there is no such thing as "the" ruling — the same intent
      // executes on the appliance and queues on-device — so publishing one unconditionally would
      // be publishing a guess.
      ...(tier ? { dispatch: resolveDispatch(schema, { tier, capability }) } : {}),
    }));

    intents.sort((a, b) => a.name.localeCompare(b.name));

    return {
      version: MANIFEST_VERSION,
      generatedAt: new Date().toISOString(),
      domains: this.getDomains(),
      entities: this.getEntities(),
      intents,
      ...(tier ? { tier } : {}),
    };
  }

  getDomains(): IntentDomain[] {
    return [...INTENT_DOMAINS];
  }

  getEntities(): CiEntityDescriptor[] {
    return [...CI_ENTITIES];
  }
}
