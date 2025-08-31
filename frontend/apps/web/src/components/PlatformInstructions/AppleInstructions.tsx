import { Card, Alert, Button } from '@ci/shadcn';
import { ExternalLink, Info } from '@ci/shadcn/icons';

export function AppleInstructions() {
  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <div>
          <div className="font-medium">Apple Developer API Setup</div>
          <div className="text-sm">
            You'll need to create certificates and keys in the Apple Developer portal to access Apple APIs.
          </div>
        </div>
      </Alert>

      <Card>
        <Card.Header>
          <Card.Title className="text-lg">Step-by-Step Instructions</Card.Title>
          <Card.Description>Follow these steps to get your Apple API credentials</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                1
              </div>
              <div>
                <div className="font-medium">Access Apple Developer Portal</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Sign in to the Apple Developer portal with your Apple ID. You'll need a paid developer
                  account for most APIs.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://developer.apple.com/', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Apple Developer Portal
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                2
              </div>
              <div>
                <div className="font-medium">Create App ID and Certificates</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Go to Certificates, Identifiers & Profiles to create your app identifier and required
                  certificates.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://developer.apple.com/account/resources/', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Certificates & Profiles
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                3
              </div>
              <div>
                <div className="font-medium">Configure Sign in with Apple (if needed)</div>
                <p className="text-sm text-muted-foreground mt-1">
                  If using Sign in with Apple, configure your Services ID and domains in the portal.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                4
              </div>
              <div>
                <div className="font-medium">Generate API Keys (if needed)</div>
                <p className="text-sm text-muted-foreground mt-1">
                  For services like MusicKit or App Store Connect API, generate and download API keys.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    window.open('https://developer.apple.com/account/resources/authkeys/list', '_blank')
                  }
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  API Keys
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                5
              </div>
              <div>
                <div className="font-medium">Copy Your Identifiers</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Copy your Team ID, App ID, Service ID, or Key ID depending on which Apple service you're
                  integrating.
                </p>
              </div>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <div className="text-sm">
              <div className="font-medium">Important Notes:</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                <li>• Most Apple APIs require a paid Apple Developer Program membership ($99/year)</li>
                <li>• API keys for Apple services expire after a set time period</li>
                <li>• Different Apple services use different authentication methods</li>
                <li>• Sign in with Apple has specific domain and privacy requirements</li>
              </ul>
            </div>
          </Alert>

          <Card className="bg-muted/50">
            <Card.Header>
              <Card.Title className="text-base">Common Apple Services</Card.Title>
            </Card.Header>
            <Card.Content>
              <div className="space-y-2 text-sm">
                <div>
                  <strong>Sign in with Apple:</strong> User authentication service
                </div>
                <div>
                  <strong>MusicKit:</strong> Access to Apple Music catalog and user libraries
                </div>
                <div>
                  <strong>App Store Connect API:</strong> App management and analytics
                </div>
                <div>
                  <strong>CloudKit:</strong> iCloud database services
                </div>
              </div>
            </Card.Content>
          </Card>
        </Card.Content>
      </Card>
    </div>
  );
}
