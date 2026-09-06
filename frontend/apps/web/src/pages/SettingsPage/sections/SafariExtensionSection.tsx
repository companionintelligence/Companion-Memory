import { Card } from '@ci/shadcn';

/**
 * How to turn on the bundled Safari Web Extension. Apple reviewers look for
 * this in the containing app; the toggle itself lives in Settings.app.
 */
export function SafariExtensionSection() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <Card.Header>
          <Card.Title>Safari extension</Card.Title>
          <Card.Description>
            Memory includes Companion Memory for Safari so pages you visit can be saved to this Memory Server.
          </Card.Description>
        </Card.Header>
        <Card.Content className="text-muted-foreground flex flex-col gap-3 text-sm">
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Open the iPhone <span className="text-foreground">Settings</span> app →{' '}
              <span className="text-foreground">Apps</span> → <span className="text-foreground">Safari</span>{' '}
              → <span className="text-foreground">Extensions</span>.
            </li>
            <li>
              Turn on <span className="text-foreground">Companion Memory</span>.
            </li>
            <li>
              Grant access to the Portal host (hub.ci.computer) and any sites you want captured. Without
              Portal access, sign-in cannot finish.
            </li>
            <li>
              In Safari, open the extension → sign in with Companion Memory → choose this Memory Server.
              That sign-in is separate from the Memory app for now.
            </li>
          </ol>
        </Card.Content>
      </Card>
    </div>
  );
}
