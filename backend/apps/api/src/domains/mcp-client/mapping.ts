import type { McpServerConfigEntity } from './entities/McpServerConfigEntity';
import type { McpSecretCodec } from './services/McpSecretCodec';
import type { McpServerConfigDraft } from './types';

/**
 * Decrypt a stored config row back into the plaintext draft shape the manager needs to actually
 * spawn/connect (real command, real secret values). Shared by {@link McpServerConfigService}
 * (test-connection on a saved config) and {@link McpClientManagerService} (every real
 * connect/reconnect) so the two never drift on what "decrypted" means.
 */
export function decryptedDraftFromEntity(
  entity: McpServerConfigEntity,
  codec: McpSecretCodec,
): McpServerConfigDraft {
  return {
    name: entity.name,
    transport: entity.transport,
    command: entity.command,
    args: entity.args ?? [],
    env: codec.decryptEntries(entity.env ?? []),
    url: entity.url,
    auth: codec.decryptAuth(entity.auth),
  };
}
