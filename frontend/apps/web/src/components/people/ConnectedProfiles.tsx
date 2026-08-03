import { Badge, Label } from '@ci/shadcn';

/**
 * Read-only view of the people system's assembled identity: the person's
 * deduped identifiers (emails/phones) and the source profiles merged into
 * them ("what Discord knows", "what Google knows"). First pass is display
 * only — merge/detach actions come later.
 */

export interface ConnectedProfileData {
  id: string;
  sourceSystem: string;
  displayName?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
  emails: string[];
  phones: string[];
  pinnedByUser: boolean;
}

interface Props {
  emails: string[];
  phones: string[];
  profiles: ConnectedProfileData[];
}

export function ConnectedProfiles({ emails, phones, profiles }: Props) {
  const hasIdentifiers = emails.length > 0 || phones.length > 0;

  if (!hasIdentifiers && profiles.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {hasIdentifiers && (
        <div className="space-y-2">
          <Label>Identifiers</Label>
          <div className="flex flex-wrap gap-1.5">
            {emails.map((email) => (
              <Badge key={`email:${email}`} variant="secondary" className="font-mono text-xs">
                {email}
              </Badge>
            ))}
            {phones.map((phone) => (
              <Badge key={`phone:${phone}`} variant="secondary" className="font-mono text-xs">
                {phone}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {profiles.length > 0 && (
        <div className="space-y-2">
          <Label>Connected profiles</Label>
          <div className="flex flex-col gap-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-2.5 py-2"
              >
                {profile.avatarUrl ? (
                  <img
                    src={profile.avatarUrl}
                    alt={profile.displayName ?? profile.sourceSystem}
                    className="h-6 w-6 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="h-6 w-6 shrink-0 rounded-full bg-muted" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {profile.displayName ?? profile.handle ?? 'Unnamed'}
                  </div>
                  {profile.handle != null && profile.displayName != null && (
                    <div className="truncate text-xs text-muted-foreground">{profile.handle}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {profile.pinnedByUser && (
                    <Badge variant="outline" className="text-[10px] uppercase">
                      Pinned
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-[10px] uppercase">
                    {profile.sourceSystem}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
