import { Card, Alert, Button } from '@ci/shadcn';
import { ExternalLink, Info } from '@ci/shadcn/icons';

export function MetaInstructions() {
  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <div>
          <div className="font-medium">Meta (Facebook) API Setup</div>
          <div className="text-sm">
            You'll need to create a Meta for Developers app to access Facebook and Instagram APIs.
          </div>
        </div>
      </Alert>

      <Card>
        <Card.Header>
          <Card.Title className="text-lg">Step-by-Step Instructions</Card.Title>
          <Card.Description>Follow these steps to get your Meta API credentials</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                1
              </div>
              <div>
                <div className="font-medium">Create a Meta Developer Account</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Sign up for a Meta for Developers account if you don't have one already.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://developers.facebook.com/', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Meta for Developers
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                2
              </div>
              <div>
                <div className="font-medium">Create a New App</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Create a new app in the Meta App Dashboard and select the appropriate app type.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://developers.facebook.com/apps/', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  My Apps Dashboard
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                3
              </div>
              <div>
                <div className="font-medium">Add Required Products</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Add Facebook Login and any other products you need (Instagram, Pages API, etc.).
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                4
              </div>
              <div>
                <div className="font-medium">Configure OAuth Settings</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Set up your OAuth redirect URIs in the Facebook Login settings.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                5
              </div>
              <div>
                <div className="font-medium">Get Your App Credentials</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Copy your App ID and App Secret from the Basic Settings page.
                </p>
              </div>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <div className="text-sm">
              <div className="font-medium">Important Notes:</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                <li>• Your app will be in Development Mode initially - switch to Live Mode when ready</li>
                <li>• Some features require app review before they can be used with Live Mode</li>
                <li>• Keep your App Secret secure and never expose it in client-side code</li>
                <li>• For Instagram APIs, you may need additional setup steps</li>
              </ul>
            </div>
          </Alert>
        </Card.Content>
      </Card>
    </div>
  );
}
