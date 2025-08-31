import { Card, Alert, Button } from '@ci/shadcn';
import { ExternalLink, Info } from '@ci/shadcn/icons';

export function SpotifyInstructions() {
  return (
    <div className="space-y-4">
      <Alert>
        <Info className="h-4 w-4" />
        <div>
          <div className="font-medium">Spotify Web API Setup</div>
          <div className="text-sm">
            You'll need to create a Spotify app in the Spotify Developer Dashboard to access the Spotify Web
            API.
          </div>
        </div>
      </Alert>

      <Card>
        <Card.Header>
          <Card.Title className="text-lg">Step-by-Step Instructions</Card.Title>
          <Card.Description>Follow these steps to get your Spotify API credentials</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                1
              </div>
              <div>
                <div className="font-medium">Log into Spotify Developer Dashboard</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Sign in with your Spotify account or create one if you don't have it.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => window.open('https://developer.spotify.com/dashboard', '_blank')}
                >
                  <ExternalLink className="h-3 w-3 mr-1" />
                  Spotify Developer Dashboard
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
                  Click "Create app" and fill out the app name, description, and redirect URI.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                3
              </div>
              <div>
                <div className="font-medium">Configure App Settings</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Set up your redirect URIs in the app settings. This is where Spotify will redirect after
                  authentication.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-6 h-6 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-sm font-medium">
                4
              </div>
              <div>
                <div className="font-medium">Get Your Credentials</div>
                <p className="text-sm text-muted-foreground mt-1">
                  Copy your Client ID and Client Secret from the app settings page.
                </p>
              </div>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <div className="text-sm">
              <div className="font-medium">Important Notes:</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                <li>• The Client Secret should be kept secure and never exposed publicly</li>
                <li>• Redirect URIs must match exactly what you configure in your app</li>
                <li>• Different Spotify API scopes provide access to different user data</li>
                <li>• Free tier has rate limits - consider Spotify for Developers premium if needed</li>
              </ul>
            </div>
          </Alert>

          <Card className="bg-muted/50">
            <Card.Header>
              <Card.Title className="text-base">Quick Reference</Card.Title>
            </Card.Header>
            <Card.Content>
              <div className="space-y-2 text-sm">
                <div>
                  <strong>Authorization URL:</strong> https://accounts.spotify.com/authorize
                </div>
                <div>
                  <strong>Token URL:</strong> https://accounts.spotify.com/api/token
                </div>
                <div>
                  <strong>API Base URL:</strong> https://api.spotify.com/v1
                </div>
              </div>
            </Card.Content>
          </Card>
        </Card.Content>
      </Card>
    </div>
  );
}
