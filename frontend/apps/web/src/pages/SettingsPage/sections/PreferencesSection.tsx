import { useEffect, useMemo, useRef, useState } from 'react';

import { useMutation } from '@apollo/client/react';
import { Button, Select } from '@ci/shadcn';

import { gql } from '@/graphql';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';
import {
  createDateTimeFormatter,
  HOUR_MINUTE,
  isTimeFormat,
  TIME_FORMATS,
  type TimeFormat,
} from '@/lib/dateTimeFormat';
import { detectBrowserTimeZone, formatTimeZoneLabel, getAvailableTimeZones } from '@/lib/timezone';

import {
  SettingsFooter,
  SettingsGroup,
  SettingsHint,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from '../kit';

const UPDATE_CURRENT_USER = gql(`
  mutation UpdateCurrentUserTimezone($input: UpdateCurrentUserInput!) {
    updateCurrentUser(input: $input) {
      id
      timezone
    }
  }
`);

/**
 * A document of its own rather than `timeFormat` added to the one above: a server that predates
 * the field fails validation for any document selecting it, and the phone apps can be newer than
 * the server they talk to — so a timezone save must never depend on it.
 */
const UPDATE_CURRENT_USER_TIME_FORMAT = gql(`
  mutation UpdateCurrentUserTimeFormat($input: UpdateCurrentUserInput!) {
    updateCurrentUser(input: $input) {
      id
      timeFormat
    }
  }
`);

const TIME_FORMAT_LABELS: Record<TimeFormat, string> = {
  auto: 'Automatic (from this device)',
  h12: '12-hour',
  h23: '24-hour',
};

export function PreferencesSection() {
  const { user, loading } = useCurrentUser();
  const savedFormatter = useDateTimeFormat();
  const [updateCurrentUser, { loading: savingTimezone }] = useMutation(UPDATE_CURRENT_USER);
  const [updateTimeFormat, { loading: savingTimeFormat }] = useMutation(UPDATE_CURRENT_USER_TIME_FORMAT);
  const saving = savingTimezone || savingTimeFormat;

  const zones = useMemo(() => getAvailableTimeZones(), []);
  const detected = useMemo(() => detectBrowserTimeZone(), []);
  const currentTimezone = user?.timezone ?? 'UTC';
  const currentTimeFormat = savedFormatter.timeFormat;

  const [selected, setSelected] = useState<string>('');
  const [selectedTimeFormat, setSelectedTimeFormat] = useState<TimeFormat>(currentTimeFormat);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimeout = useRef<number | null>(null);
  // The example is "what a time will look like", so it shows one: the minute the page opened,
  // on the person's own clock, re-written as they move through the options.
  const [exampleInstant] = useState(() => new Date());

  // Prefill (and re-sync after a successful save) from the loaded user.
  useEffect(() => {
    if (user?.timezone) {
      setSelected(user.timezone);
    }
  }, [user?.timezone]);

  useEffect(() => {
    setSelectedTimeFormat(currentTimeFormat);
  }, [currentTimeFormat]);

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

  const example = createDateTimeFormatter({
    timeFormat: selectedTimeFormat,
    timeZone: savedFormatter.timeZone,
  }).time(exampleInstant, HOUR_MINUTE);

  const timezoneDirty = selected !== '' && selected !== currentTimezone;
  const timeFormatDirty = selectedTimeFormat !== currentTimeFormat;
  const dirty = timezoneDirty || timeFormatDirty;

  const handleSave = async () => {
    if (!dirty) {
      return;
    }

    setError(null);
    try {
      if (timezoneDirty) {
        await updateCurrentUser({ variables: { input: { timezone: selected } } });
      }
    } catch {
      setError('Failed to save timezone. Please try again.');

      return;
    }

    try {
      if (timeFormatDirty) {
        await updateTimeFormat({ variables: { input: { timeFormat: selectedTimeFormat } } });
      }
    } catch {
      setError('Failed to save time format. Please try again.');

      return;
    }

    setSaved(true);
    if (savedTimeout.current) {
      window.clearTimeout(savedTimeout.current);
    }

    savedTimeout.current = window.setTimeout(() => setSaved(false), 2500);
  };

  return (
    <SettingsSection
      title="Preferences"
      description="Your timezone and how times are written."
      help="Predictions, summaries and insights use your timezone to line up with your local day."
    >
      <SettingsGroup>
        <SettingsRow label="Timezone" htmlFor="timezone">
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

          <SettingsHint>
            Detected from this browser:{' '}
            <button
              type="button"
              className="cursor-pointer underline underline-offset-2 hover:text-foreground disabled:cursor-default disabled:no-underline disabled:opacity-60"
              onClick={() => setSelected(detected)}
              disabled={selected === detected}
            >
              {formatTimeZoneLabel(detected)}
            </button>
          </SettingsHint>
        </SettingsRow>

        <SettingsRow label="Time format" htmlFor="time-format">
          <Select
            value={selectedTimeFormat}
            onValueChange={(value) => {
              if (isTimeFormat(value)) {
                setSelectedTimeFormat(value);
              }
            }}
            disabled={loading}
          >
            <Select.Trigger id="time-format" className="w-full">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {TIME_FORMATS.map((format) => (
                <Select.Item key={format} value={format}>
                  {TIME_FORMAT_LABELS[format]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select>

          <SettingsHint data-testid="time-format-example">
            Times will look like <span className="text-foreground tabular-nums">{example}</span>
          </SettingsHint>
        </SettingsRow>

        <SettingsFooter
          status={
            error ? (
              <SettingsStatus tone="error">{error}</SettingsStatus>
            ) : saved ? (
              <SettingsStatus tone="success">Saved</SettingsStatus>
            ) : null
          }
        >
          <Button onClick={handleSave} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </SettingsFooter>
      </SettingsGroup>
    </SettingsSection>
  );
}
