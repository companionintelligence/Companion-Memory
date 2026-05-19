export { SCOPES, DEFAULT_READ_SCOPES, matchScope, matchScopes, missingScopes } from './taxonomy';
export type { Scope } from './taxonomy';
export { Scopes, SCOPES_METADATA_KEY } from './decorator';
export { ScopesGuard } from './ScopesGuard';
export { AuthDenialEntity, type AuthDenialReason } from './AuthDenialEntity';
export { AuthDenialLogger, type AuthDenialRecord } from './AuthDenialLogger';
export { AuthScopesModule } from './AuthScopesModule';
