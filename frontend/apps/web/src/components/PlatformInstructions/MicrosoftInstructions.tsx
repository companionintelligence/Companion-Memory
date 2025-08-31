import { Card, Alert, Button } from '@ci/shadcn';
import { ExternalLink, Info } from '@ci/shadcn/icons';

export function MicrosoftInstructions() {
  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <div>
          <div className="font-medium">Microsoft Azure API Setup</div>
          <div className="text-sm">
            You'll need to register an application in Azure Active Directory to access Microsoft APIs.
          </div>
        </div>
      </Alert>

      <Card>
        <Card.Header>
          <Card.Title className="text-lg">Step-by-Step Instructions</Card.Title>
          <Card.Description>Follow these steps to get your Microsoft Azure API credentials</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                1
              </div>
              <div>
                <div className="font-medium">Access Azure Portal</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Sign in to the Azure portal with your Microsoft account.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://portal.azure.com/', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Azure Portal
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                2
              </div>
              <div>
                <div className="font-medium">Register an Application</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Go to Azure Active Directory &gt; App registrations and create a new registration.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() =>
                    window.open(
                      'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
                      '_blank',
                    )
                  }
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  App Registrations
                </Button>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                3
              </div>
              <div>
                <div className="font-medium">Configure Authentication</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Add redirect URIs under Authentication settings for your application.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                4
              </div>
              <div>
                <div className="font-medium">Create a Client Secret</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Go to Certificates & secrets and create a new client secret.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                5
              </div>
              <div>
                <div className="font-medium">Configure API Permissions</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Add the required Microsoft Graph or other API permissions under API permissions.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                6
              </div>
              <div>
                <div className="font-medium">Copy Your Credentials</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Copy the Application (client) ID and the client secret value.
                </p>
              </div>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <div className="text-sm">
              <div className="font-medium">Important Notes:</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                <li>• Client secrets have expiration dates - set reminders to renew them</li>
                <li>• Some Microsoft APIs require admin consent for certain permissions</li>
                <li>• Use the Application ID as your Client ID in the form below</li>
                <li>• Microsoft Graph API provides access to Office 365, Outlook, OneDrive, and more</li>
              </ul>
            </div>
          </Alert>
        </Card.Content>
      </Card>
    </div>
  );
}
