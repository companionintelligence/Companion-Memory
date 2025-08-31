import { Card, Alert, Button } from '@ci/shadcn';
import { ExternalLink, Info } from '@ci/shadcn/icons';

export function GoogleInstructions() {
  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <div>
          <div className="font-medium">Google API Setup</div>
          <div className="text-sm">
            You'll need to create a Google Cloud Project and enable the required APIs to connect your Google
            services.
          </div>
        </div>
      </Alert>

      <Card>
        <Card.Header>
          <Card.Title className="text-lg">Step-by-Step Instructions</Card.Title>
          <Card.Description>Follow these steps to get your Google API credentials</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                1
              </div>
              <div>
                <div className="font-medium">Create a Google Cloud Project</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Go to the Google Cloud Console and create a new project or select an existing one.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://console.cloud.google.com/projectcreate', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Google Cloud Console
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                2
              </div>
              <div>
                <div className="font-medium">Enable Required APIs</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Enable the APIs you want to use (Gmail, Calendar, Drive, etc.) in the API Library.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://console.cloud.google.com/apis/library', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  API Library
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                3
              </div>
              <div>
                <div className="font-medium">Create OAuth 2.0 Credentials</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Go to the Credentials section and create new OAuth 2.0 Client ID credentials.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://console.cloud.google.com/apis/credentials', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  API Credentials
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                4
              </div>
              <div>
                <div className="font-medium">Copy Your Credentials</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Copy the Client ID and Client Secret from your OAuth 2.0 credentials and paste them in the
                  form below.
                </p>
              </div>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <div className="text-sm">
              <div className="font-medium">Important Notes:</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                <li>• Make sure to add your redirect URI to the authorized redirect URIs list</li>
                <li>• Keep your Client Secret secure and never share it publicly</li>
                <li>• Different Google services may require different scopes to be enabled</li>
              </ul>
            </div>
          </Alert>
        </Card.Content>
      </Card>
    </div>
  );
}
