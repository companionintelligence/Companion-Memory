import type { LlmEndpointPreflight } from '@/hooks/useLlmEndpoint';

/**
 * What Test connection found: the server's message, then the command it suggests when it has one (a
 * ufw rule when a firewall on the computer Memory runs on drops its containers' connections). The
 * command sits on its own line as code, so it reads as something to run and selects with one click.
 *
 * A fragment, so the message stays a direct text child of whatever status element holds it.
 */
export function EndpointCheckMessage({ preflight }: { preflight: LlmEndpointPreflight }) {
  return (
    <>
      {preflight.message ?? (preflight.ok ? 'Connected.' : 'Connection failed.')}
      {preflight.fixCommand ? (
        <code className="mt-2 block w-fit max-w-full select-all whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
          {preflight.fixCommand}
        </code>
      ) : null}
    </>
  );
}
