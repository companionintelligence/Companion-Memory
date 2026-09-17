import { useDeviceLayout, usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { ChevronLeft, ChevronRight, LogOut } from '@ci/shadcn/icons';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { PersonAvatar } from '@/components/PersonAvatar';
import { useAuth, useCurrentUser } from '@/hooks';
import { HELP_LINKS } from '@/layouts/Main/railDestinations';
import { visibleSettingsSections } from '@/pages/SettingsPage/settingsNav';
import { SettingsSectionBody } from '@/pages/SettingsPage/SettingsSections';

const SETTINGS_HUB = '/self/settings';

/**
 * Phone-only settings hub, now under Self. Desktop settings stay a dialog;
 * this is the same section bodies plus Help and Log out, as a real page.
 */
export function ProfilePage() {
  usePageTitle('Settings - Companion Memory');

  const { isMobile } = useDeviceLayout();

  if (isMobile == null) {
    return null;
  }

  if (!isMobile) {
    // A synthesized backgroundLocation, not the real referrer — this route is
    // reached directly (a bookmark, a redirect), with no prior page to fall
    // back to. Without it, SettingsPage's own `location.state.backgroundLocation`
    // is undefined too, so it portals over a blank `<main>` and Escape/Close
    // falls back to `appHomePath()` instead of back to Self, where this
    // destination conceptually lives.
    return (
      <Navigate
        to="/settings/appearance"
        state={{ backgroundLocation: { pathname: '/self', search: '', hash: '' } }}
        replace
      />
    );
  }

  return (
    <Routes>
      <Route index element={<ProfileHub />} />
      <Route path=":section" element={<ProfileSection />} />
    </Routes>
  );
}

function ProfileHub() {
  const { user } = useCurrentUser();
  const [, { logout }] = useAuth();

  const name = user?.name || user?.email || 'User';
  const email = user?.email || '';

  return (
    <PageContent className="pb-8">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6 pb-4">
        <div className="flex items-center gap-3 px-1">
          {/* size="lg" is 48px — the exact h-12 w-12 this rendered before
              PersonAvatar existed. */}
          <PersonAvatar name={name} avatarUrl={user?.avatarUrl} size="lg" />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{name}</h1>
            {email ? <p className="truncate text-sm text-muted-foreground">{email}</p> : null}
          </div>
        </div>

        <section className="flex flex-col gap-1">
          <h2 className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </h2>
          {visibleSettingsSections().map((section) => {
            const Icon = section.icon;

            return (
              <Link
                key={section.id}
                to={`${SETTINGS_HUB}/${section.id}`}
                className="flex items-center gap-3 rounded-md px-3 py-3 text-sm transition-colors hover:bg-accent"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{section.label}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </Link>
            );
          })}
        </section>

        <section className="flex flex-col gap-1">
          <h2 className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Help</h2>
          {HELP_LINKS.map((link) => {
            const Icon = link.icon;

            return (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-md px-3 py-3 text-sm transition-colors hover:bg-accent"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{link.label}</span>
              </a>
            );
          })}
        </section>

        <Button variant="destructive" className="justify-center" onClick={() => void logout()}>
          <LogOut className="h-4 w-4" />
          Log out
        </Button>
      </div>
    </PageContent>
  );
}

function ProfileSection() {
  const { section } = useParams<{ section: string }>();

  return (
    <PageContent>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
        <Link
          to={SETTINGS_HUB}
          className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Settings
        </Link>
        <SettingsSectionBody section={section ?? ''} fallbackTo={SETTINGS_HUB} />
      </div>
    </PageContent>
  );
}
