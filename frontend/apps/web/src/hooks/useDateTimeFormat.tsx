import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { useQuery } from '@apollo/client';

import { resolveTimeZone } from '@/components/HorizonGrid/zonedClock';
import { gql } from '@/graphql';
import {
  createDateTimeFormatter,
  DEVICE_DATE_TIME_FORMATTER,
  type DateTimeFormatter,
} from '@/lib/dateTimeFormat';

import { useCurrentUser } from './useCurrentUser';

/**
 * The hour-cycle preference, fetched on its own rather than as a field of `GetUserData`.
 *
 * The phone apps ship this web build and connect to whichever Memory server the person runs,
 * which can be older than the app. A server without `timeFormat` fails validation for the whole
 * document it appears in, and `GetUserData` is the query every signed-in screen waits on — so a
 * display preference there could take the app down against an older server. Here it can only
 * fail on its own, and `errorPolicy: 'ignore'` turns that into "automatic".
 */
export const USER_TIME_FORMAT_QUERY = gql(`
  query GetUserTimeFormat {
    me {
      id
      timeFormat
    }
  }
`);

const DateTimeFormatContext = createContext<DateTimeFormatter>(DEVICE_DATE_TIME_FORMATTER);

/**
 * Formatters for the signed-in person's time format and timezone. Outside the provider (tests,
 * stories) it is the device's own behaviour, which is also what `'auto'` in the device's zone
 * prints — so a component that has not been given a preference reads exactly as it always did.
 */
export function useDateTimeFormat(): DateTimeFormatter {
  return useContext(DateTimeFormatContext);
}

/** Test and story seam: renders `children` with a formatter of the caller's choosing. */
export function DateTimeFormatOverride({
  formatter,
  children,
}: {
  formatter: DateTimeFormatter;
  children: ReactNode;
}) {
  return <DateTimeFormatContext.Provider value={formatter}>{children}</DateTimeFormatContext.Provider>;
}

/**
 * Puts the signed-in person's preferences behind {@link useDateTimeFormat}, once, for the whole
 * tree. Mounted inside the Apollo provider.
 *
 * The zone is resolved exactly as Plan and Schedule resolve it — the profile zone, or the
 * browser's when there is no usable one — so every page shows an instant on the same clock the
 * planner placed it on. Until the account has loaded both preferences fall back to the device's.
 */
export function DateTimeFormatProvider({ children }: { children: ReactNode }) {
  const { user } = useCurrentUser();
  const { data } = useQuery(USER_TIME_FORMAT_QUERY, { skip: !user, errorPolicy: 'ignore' });

  const timeFormat = data?.me?.timeFormat ?? 'auto';
  const timeZone = resolveTimeZone(user?.timezone);
  const formatter = useMemo(() => createDateTimeFormatter({ timeFormat, timeZone }), [timeFormat, timeZone]);

  return <DateTimeFormatContext.Provider value={formatter}>{children}</DateTimeFormatContext.Provider>;
}
