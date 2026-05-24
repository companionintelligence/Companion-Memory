import { Button, Card } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

export default function NotFoundPage() {
  const [{ expired }] = useAuth();
  const { user } = useCurrentUser();

  const homePath = !expired && user ? '/feed' : '/';

  return (
    <div className="flex h-lvh w-full items-center justify-center p-6 md:p-10">
      <Card className="w-full max-w-md shadow-2xl rounded-2xl border">
        <Card.Header>
          <Card.Title className="text-4xl font-bold text-center">404</Card.Title>
        </Card.Header>
        <Card.Content>
          <p className="mb-6 text-center text-muted-foreground text-lg">
            Sorry, the page you are looking for was not found.
          </p>
          <div className="flex justify-center">
            <Button variant="default" asChild>
              <Link to={homePath}>Go Home</Link>
            </Button>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
