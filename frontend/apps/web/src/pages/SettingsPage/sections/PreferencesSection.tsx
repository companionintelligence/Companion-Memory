import { useEffect, useMemo, useRef, useState } from 'react';

import { useMutation } from '@apollo/client';
import { Button, Card, Label, Select } from '@ci/shadcn';
import { Check, Globe } from '@ci/shadcn/icons';

import { gql } from '@/graphql';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { detectBrowserTimeZone, formatTimeZoneLabel, getAvailableTimeZones } from '@/lib/timezone';

const UPDATE_CURRENT_USER = gql(`
  mutation UpdateCurrentUserTimezone($input: UpdateCurrentUserInput!) {
    updateCurrentUser(input: $input) {
      id
      timezone
    }
  }
`);

export function PreferencesSection() {
  const { user, loading } = useCurrentUser();
  const [updateCurrentUser, { loading: saving }] = useMutation(UPDATE_CURRENT_USER);

  const zones = useMemo(() => getAvailableTimeZones(), []);
  const detected = useMemo(() => detectBrowserTimeZone(), []);
  const currentTimezone = user?.timezone ?? 'UTC';

  const [selected, setSelected] = useState<string>('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimeout = useRef<number | null>(null);

  // Prefill (and re-sync after a successful save) from the loaded user.
  useEffect(() => {
    if (user?.timezone) {
      setSelected(user.timezone);
    }
  }, [user?.timezone]);

  // Cancel the "Saved" reset timer if the section unmounts (e.g. modal closed).
  useEffect(
    () => () => {
      if (savedTimeout.current) {
        window.clearTimeout(savedTimeout.current);
      }
    },
    [],
  );

  // Ensure the current + detected zones are always selectable, even on the
  // curated fallback list or an unusual stored value.
  const options = useMemo(
    () => Array.from(new Set([currentTimezone, detected, ...zones].filter(Boolean))).sort(),
    [zones, detected, currentTimezone],
  );

  const dirty = selected !== '' && selected !== currentTimezone;

  const handleSave = async () => {
    if (!dirty) {
      return;
    }

    setError(null);
    try {
      await updateCurrentUser({ variables: { input: { timezone: selected } } });
      setSaved(true);
      if (savedTimeout.current) {
        window.clearTimeout(savedTimeout.current);
      }

      savedTimeout.current = window.setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save timezone. Please try again.');
    }
  };

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Preferences</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Set your timezone so predictions, summaries, and insights line up with your local day.
        </p>
      </div>

      <Card>
        <Card.Content className="space-y-4 pt-6">
          <div className="grid gap-2">
            <Label htmlFor="timezone" className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Timezone
            </Label>

            <Select value={selected} onValueChange={setSelected} disabled={loading}>
              <Select.Trigger id="timezone" className="w-full">
                <Select.Value placeholder={loading ? 'Loading…' : 'Select a timezone'} />
              </Select.Trigger>
              <Select.Content className="max-h-80">
                {options.map((zone) => (
                  <Select.Item key={zone} value={zone}>
                    {formatTimeZoneLabel(zone)}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>

            <p className="text-xs text-muted-foreground">
              Detected from this browser:{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60"
                onClick={() => setSelected(detected)}
                disabled={selected === detected}
              >
                {formatTimeZoneLabel(detected)}
              </button>
            </p>
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            {saved ? (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <Check className="h-4 w-4" />
                Saved
              </span>
            ) : null}
          </div>
        </Card.Content>
      </Card>
    </>
  );
}
