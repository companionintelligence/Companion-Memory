/** Default post-login landing route when chat is enabled. */
export function defaultAppRoute(isFeatureEnabled: (name: string) => boolean): string {
  return isFeatureEnabled('chat.page') ? '/chat' : '/feed';
}
