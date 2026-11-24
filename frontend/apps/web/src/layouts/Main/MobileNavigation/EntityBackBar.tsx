import { Button } from '@ci/shadcn';
import { ChevronLeft } from '@ci/shadcn/icons';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * The first path segment of every entity full page: where the explorer drawer's
 * "Open full page" goes (`FULL_PAGE_PATHS` in EntityDetailScaffold). A test holds
 * the two lists together, so a new kind cannot get a page with no way back.
 */
const ENTITY_PAGE_ROOTS = [
  'communications',
  'concepts',
  'content',
  'events',
  'items',
  'notes',
  'people',
  'places',
  'receipts',
] as const;

const ENTITY_PAGE_PATH = new RegExp(`^/(?:${ENTITY_PAGE_ROOTS.join('|')})/[^/]+/?$`);

/** Whether `pathname` is one record's own page (`/events/:id`, `/people/:id`, …). */
export function isEntityPagePath(pathname: string): boolean {
  return ENTITY_PAGE_PATH.test(pathname);
}

/**
 * A visible Back on an entity's full page, on the phone.
 *
 * "Open full page" routes in place, so the explorer — with its filters, which
 * live in the URL — is one history step behind. On a desktop browser that step
 * is the Back button. A phone has none: iOS shows no browser chrome, the web
 * view does not swipe back, and the header's only left-hand control opens the
 * menu. The page was a dead end whose one way out, the sidebar, dropped the
 * explorer's filters (QA MEM-05).
 *
 * It lives in the header area rather than in each page so the pages that have no
 * header of their own to put it in — still loading, failed, or "not found" — get
 * it too, which is exactly when someone wants out.
 */
export function EntityBackBar() {
  const { pathname, key } = useLocation();
  const navigate = useNavigate();

  if (!isEntityPagePath(pathname)) {
    return null;
  }

  const goBack = () => {
    // `default` is the key of the first entry of a session: nothing in the app is
    // behind it (a link opened cold), and stepping back would leave the app.
    if (key === 'default') {
      navigate('/memory', { replace: true });

      return;
    }

    navigate(-1);
  };

  return (
    <div className="shrink-0 px-1 pb-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-10 gap-1 px-2 text-muted-foreground"
        onClick={goBack}
      >
        <ChevronLeft aria-hidden className="h-4 w-4" />
        Back
      </Button>
    </div>
  );
}
