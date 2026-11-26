# Set up, monitor, and recover your Memory

## Save account recovery codes

Open **Settings → Account → Recovery codes** in a signed-in browser, confirm your
current local Memory password, and choose **Generate new recovery codes**. If you
have never chosen a local password, a web sign-in within the last ten minutes is
required instead. In the native app, **Needs a web sign-in** shows the Memory
server address to open in a browser for these controls; a device API key cannot
change account credentials.

Eight codes are shown once. Copy them to a password manager or another private
location outside this Memory, then choose **I saved these codes** to clear the
display. Each code is single-use. Generating another set invalidates every code
from the old set, including any you have not used. The server stores digests and
cannot show or recreate the original codes later.

On the email sign-in screen, expand **Recover with a recovery code**, enter the
account email, an unused code, and your new local Memory password. After recovery,
sign in again. Recovery revokes every Memory browser session, pre-reset access
token, and key minted for a signed-in phone or desktop app. Explicit API keys for
your tools and Hub-managed app connections retain their own lifecycle; revoke them
separately if you no longer trust them. Other unused recovery codes remain valid.

This resets the local Memory password. It does not reset a Companion/Portal or
other identity-provider password. Without an unused saved code, use your existing
Companion sign-in or the appliance operator's account recovery procedure. Repeated
failed attempts are throttled; wait for the requested interval before retrying.
The reset and credential revocations are one transaction: a failed operation does
not consume the code or leave the password partly changed.

## Finish the first sync

The last setup step asks the Memory server to start the first sync and waits up to 15
seconds for it to accept the request. If the request fails or times out, the step stays
and shows the error with **Retry first sync**. **Finish without syncing** is always
available. Finishing setup does not mean that source records have finished downloading or
indexing.

The Getting started banner shows saved records and indexing progress. If a refresh fails,
it says **Sync status needs attention**, keeps the counts from the last successful check
and says so, and offers **Check again** and **System status**. A missing search-index
response shows as "Checking the search index" and is never treated as an empty queue.

Go to **Settings → System status → Sync now** to retry later. **Manage sources** opens
connected accounts: reconnect any account that needs a fresh sign-in. If automatic syncing
is paused, the first sync and **Sync now** both refuse to start, and System status asks you
to have the appliance administrator switch scheduled connection sync
(`scheduled.connection.sync`) back on. Imports remain available when a provider cannot
connect.

## Read System status

**Settings → System status** is available on desktop and mobile. It checks:

- the database and configured chat model;
- photos and attachment storage;
- Summary, document parser, and HBPE service health;
- your queued, active, failed, and delayed background jobs;
- source sign-in requirements and the last completed source transform.

Checks refresh every 30 seconds while the page is visible. **Check again** refreshes
immediately. A failed request leaves the previous results visible with an explicit stale
result warning. **Check model**, **Manage sources**, and **View jobs** (when the Jobs page
is enabled) open the relevant recovery surface; administrative job controls require an
administrator account.

A waiting job becomes delayed after 15 minutes beyond its scheduled start; an active job
becomes delayed after two hours. A large import can legitimately exceed these thresholds.
They are prompts to investigate progress, not automatic cancellation rules.

A ready service has answered its health check. It does not prove that every record was
imported, every file was parsed, or every generated answer is accurate. Failed-job totals
include retained failures; use Jobs to inspect and retry the appropriate work.

Administrators also see complete-appliance backup status when `CI_BACKUP_STATUS_FILE`
names the sanitized status file the backup scheduler publishes. No status file shows as
**Not configured**. A backup that failed, is overdue (its last success is more than 48
hours old) or cannot be read shows **Needs attention**. This surface exposes the outcome,
last successful time, size, and coverage, without exposing backup paths or errors. See the
[complete backup and recovery guide](operations/backup-and-recovery.md) for scheduling,
mounting the status file and restore drills. Account export is a separate portability
operation.

## Create a reminder

Open **Plan**, expand **Reminders** under the new-task form, choose an active task and your
local date and time, then choose **Add reminder**. The client converts that local time to
an instant before saving it, and a time that is not in the future is refused.

### Browser and installed web app

Choose **Enable notifications** on each browser that should receive notifications.
Notification permission and a configured Web Push key pair are required. On iPhone,
install the web app on the Home Screen and open it there before enabling notifications.

A saved reminder starts as **Waiting to send**. The server claims it with a ten-minute
lease, sends the notification, and records the outcome only after a push provider accepts
it. **Accepted by notification service** means provider acceptance; the app cannot prove
that a person saw the notification. A stable notification tag coalesces duplicate retries.

Failed deliveries retry with backoff at one, two, four, and eight minutes, up to five
attempts. A dead browser subscription is removed. No subscribed browser is a delivery
failure, not a success: enable notifications, then use **Retry delivery**. The app does not
silently discard the reminder. **Cancel reminder** prevents future attempts; a notification
already handed to a provider may still arrive.

### iPhone and Android app

The native app schedules the reminder through the phone's operating system. Allow
notification permission, then add the reminder. **Scheduled on a device · delivery
unconfirmed** means the OS accepted the schedule; it is distinct from a browser delivery
receipt. The phone can display a scheduled notification while offline.

If scheduling fails after saving, the record remains visible with **Schedule on this
phone**. Retry before the selected time. Cancel on that phone to remove both the local
notification and the server schedule. If cancelled from another device, the phone removes
its local copy when it next opens the plan and reconnects. Keep this limit in mind before
cancelling a near-term phone reminder remotely. OS notification settings, Focus modes,
power restrictions, and device shutdown can affect presentation.

Completing a task suppresses server push at dispatch time. Phone notifications are
scheduled ahead of time: reopen the plan after completing or removing a task on another
device to reconcile its local schedule. Native schedules are not APNs/FCM remote push.

## Delete an account completely

Deleting your account from the app ends access at once and erases the data after a grace
period (30 days unless the operator changed it). The privacy endpoint
`POST /api/users/me/delete` erases at once instead. It needs a key with full account
authority (an installed app's key is refused) and your account email repeated in
`confirmEmail`. If other accounts remain, the last administrator must name a successor
(`successorEmail`) before deletion proceeds.

Both routes end the account first, so nobody can sign in to it or read through it, and then
erase its rows in batches. If a step fails or is interrupted, the API answers that erasure
is still pending (`deleting`) rather than reporting it complete, the account stays closed,
and the purge retries on its own. [Account deletion and the data
purge](architecture/account-deletion.md) describes the order of the steps, what is
revoked, and how the audit trail is written.

Deleting active appliance data does not erase independent snapshots already retained by
an operator. Manage those snapshots according to the appliance's retention policy.
