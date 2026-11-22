import { SettingsGroup, SettingsRow, SettingsSection } from '../kit';

/**
 * How to turn on the bundled Safari Web Extension. Apple reviewers look for
 * this in the containing app; the toggle itself lives in Settings.app.
 */
export function SafariExtensionSection() {
  return (
    <SettingsSection
      title="Safari extension"
      description="Memory includes Companion Memory for Safari so pages you visit can be saved to this Memory Server."
    >
      <SettingsGroup title="Turn it on">
        <SettingsRow>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              Open the iPhone <span className="text-foreground">Settings</span> app &gt;{' '}
              <span className="text-foreground">Apps</span> &gt;{' '}
              <span className="text-foreground">Safari</span> &gt;{' '}
              <span className="text-foreground">Extensions</span>.
            </li>
            <li>
              Turn on <span className="text-foreground">Companion Memory</span>.
            </li>
            <li>
              Grant access to the Portal host (hub.ci.computer) and any sites you want captured. Without
              Portal access, sign-in cannot finish.
            </li>
            <li>
              In Safari, open the extension, sign in with Companion Memory and choose this Memory Server. That
              sign-in is separate from the Memory app for now.
            </li>
          </ol>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
