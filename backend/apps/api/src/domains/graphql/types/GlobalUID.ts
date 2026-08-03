// Canonical implementation lives in @ci/common/ids (the id contract is shared
// with the agent intents and MCP); re-exported here so graphql-internal
// relative imports keep working.
export { GlobalUID, type ResourceType } from '@ci/common/ids';
