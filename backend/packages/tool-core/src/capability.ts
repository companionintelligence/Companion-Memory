/**
 * The authority vocabulary the tool policy gates on.
 *
 * This is a deliberate, and deliberately small, mirror of `ApiKeyCapability` in the API's
 * `common/decorators`. The API keeps that name — it is what a `RequireCapability` decorator and an
 * `ci.api_keys` row talk about — but the *rule* that reads it ({@link capabilityAllows}) lives
 * here, because it is the intent catalog's rule rather than any one transport's.
 *
 * The two unions are held identical by a compile-time assertion on the API side
 * (`domains/tools/toolCoreContract.ts`), so a level added or renamed in either place is a type
 * error rather than a silent hole in the gate.
 */
export const TOOL_CAPABILITIES = ['read', 'write', 'full'] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** May read the user's data. The floor. */
export const READ_CAPABILITY: ToolCapability = 'read';

/** May read and add, but never remove. */
export const WRITE_CAPABILITY: ToolCapability = 'write';

/** The owner's own authority: everything, data loss included. */
export const FULL_CAPABILITY: ToolCapability = 'full';
