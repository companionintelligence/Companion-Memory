import type { RequestContext } from '@ci/common/context';
import type { ApiKeyCapability } from '@ci/common/decorators';
import type { ToolCapability, ToolRequestContext } from '@ci/tool-core';

/**
 * The types `@ci/tool-core` restates rather than imports, checked at compile time.
 *
 * The package cannot import them: `RequestContext` arrives with Nest middleware,
 * `ApiKeyCapability` with a Nest decorator, and `PersonalizationDecision` (asserted over in
 * `policy/toolGate.ts`, where that import already lives) with a domain full of Nest services —
 * while the package's whole point is that a CLI or an on-device dispatcher can depend on the tool
 * rules without any of that. So it declares its own {@link ToolRequestContext},
 * {@link ToolCapability} and `TrustDecision`, and the two sides meet structurally.
 *
 * Structural agreement is not the same as staying in agreement, and one of these is a security
 * vocabulary: add a capability level on one side only and `capabilityAllows` meets a value it has
 * no branch for, while `capabilityRequiredFor` names a level that does not exist. Every field of
 * `RequestContext` is optional, too, so a renamed field would keep assigning cleanly and simply
 * stop reaching the ledger.
 *
 * These assertions turn both into compile errors. They cost nothing at runtime — the file emits no
 * JavaScript — and they are what makes the mirrored declarations in the package safe to have.
 */

/** Fails to compile unless `T` is exactly `true`. */
export type Assert<T extends true> = T;

/** True only when `A` and `B` accept exactly each other — neither is merely a subset. */
export type Identical<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The gate's authority vocabulary. `capabilityAllows` refuses data-removing work to anything that
 * is not `full`, so an unknown level would be refused rather than admitted — but a new level meant
 * to sit *below* `read` would be treated as `read`'s equal, and a refusal would name a level the
 * appliance cannot grant.
 */
export type CapabilityVocabularyIsShared = Assert<Identical<ApiKeyCapability, ToolCapability>>;

/** The request facts the ledger row is built from. A widened or renamed field silently loses one. */
export type RequestContextIsShared = Assert<Identical<Required<RequestContext>, Required<ToolRequestContext>>>;
