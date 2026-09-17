/**
 * The capability rule. **Defined in `@ci/tool-core`; re-exported here.**
 *
 * It was born in `McpToolService`, which made the privacy label mean something only to callers who
 * arrived over MCP; moving it into this domain put it behind `ToolRegistry.executeTool`, where
 * every transport meets it. Moving it again — into a package with no framework in it — is the same
 * move made once more: the on-device tier and a CLI dispatcher can now apply the identical
 * function rather than each re-deriving it. Two copies of a security rule are two rules.
 */
export {
  capabilityAllows,
  capabilityRequiredFor,
  removesData,
  type GatedPrivacy,
} from '@ci/tool-core';
