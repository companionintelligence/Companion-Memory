-- migrate:up

-- How the apps write a time of day for this person: 'auto' leaves the hour
-- cycle to the device's language settings (what every page did before this
-- column existed), 'h12' always writes "3:43 PM" and 'h23' always writes
-- "15:43". The values are the Intl `hourCycle` names, which the web app passes
-- straight through to its formatters.
--
-- It sits next to `timezone` because it is the same kind of setting: a display
-- preference that follows the person from the web app to their phone, where a
-- per-device setting would not. NOT NULL with a default, rather than NULL
-- meaning "automatic", so every existing account reads as 'auto' without a
-- backfill and there is exactly one spelling of "never chosen". The CHECK is
-- the backstop for writers that bypass the GraphQL enum.
ALTER TABLE ci.users
    ADD COLUMN time_format text NOT NULL DEFAULT 'auto'
    CONSTRAINT users_time_format_check CHECK (time_format IN ('auto', 'h12', 'h23'));

-- migrate:down

ALTER TABLE ci.users DROP COLUMN time_format;
