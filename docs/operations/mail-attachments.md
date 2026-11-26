# Mail attachments

Gmail and Outlook Mail connections save the attachments of the mail they import. Each file is stored in Memory's own file storage and linked to the imported message, so opening it does not depend on a temporary download URL from the provider.

Each attachment also gets a content record (a document or a media item) that the message points to. That record is what stays when the file itself could not be saved.

## What is saved

- **Gmail.** Every MIME part with a file name, a `Content-Disposition: attachment` header, or a downloadable body that is not message text, wherever it sits in the message, inline images included. The bytes come from the authenticated Gmail attachment endpoint, or from data the message already carried inline.
- **Outlook.** File attachments, from the authenticated Microsoft Graph attachment endpoint. The sync lists the attachments of every message that has any, reading every page of the list, and follows a next-page link only if it stays on `graph.microsoft.com` and on the same message's attachments. A message whose only attachments are inline images is found by the `cid:` image references in its body, because Graph's `hasAttachments` flag leaves inline attachments out, as the [message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0) describes.
- **Only mail that is imported.** Drafts and the bulk mail the import filters out are dropped before any file is downloaded. For Outlook the attachment list is read in the sync step, before that filter, but only the list: no bytes are fetched for mail that is dropped.

## Limits

- Each file is limited to **25 MiB**. A larger file is not saved. Its record stays, and says that the bytes were not saved because of the limit. The size the provider declares is checked first, so a file it says is too large is never downloaded. If the declared size is missing or wrong, the bytes that arrive are checked too, and an Outlook download is stopped as soon as it passes the limit.
- Outlook linked files and attached items, and Gmail parts that carry no downloadable bytes (a nested message, for example), are kept the same way: a record that says the type is not supported, and no file.
- At most **two** attachments are downloaded and saved at a time in an API process, however many messages a sync page holds.
- The same file attached to several messages is stored once, by the usual per-user hash match, and each attachment still has its own record.
- Saving a document does not mean it has been read. It then goes through the same parsing and indexing as any uploaded file, and whether its text can be searched depends on its format, on the parser being available, and on the file's processing status.

## Access tokens

A page is transformed some time after the sync fetched it, and the sync renews a connection's access token only once it has run out. So before a download, the connection is read again, in case a sync has renewed its token since, and the token is renewed first if it has run out or has less than ten minutes left. A renewed token is saved on the connection, as the sync saves it, and downloads that need a renewal at the same moment share one. If the renewal fails, the download goes ahead with the token it has, and fails by itself if that token is dead.

## One record per mailbox

An attachment is identified by the connection it came from, the message, and the attachment within that message: for Gmail the part's position in the message, for Outlook Graph's attachment id. Provider ids only mean something inside their own mailbox, so two connected mailboxes never share a record or borrow each other's bytes. Gmail's own attachment id is not used for this, because Google does not document it as the same on every read of a message. Reading a message again therefore finds the record it made before.

A record that exists with its file is reused as it is: nothing is downloaded or uploaded again. A record that was kept without a file is updated if the file can be saved on a later pass.

## When saving fails

- **Outlook attachment lists.** If the list for a message cannot be read, or its paging repeats or leaves the message's own attachments, the sync job for that page fails and its cursor is not saved. The next job starts from the last cursor that was saved, so the page is fetched again. As for every connector, an endpoint whose very first job fails is not started again on its own.
- **Bytes.** If a download or save fails (the provider refuses, the attachment is gone, the object store is unavailable), the message is still imported, without that attachment. It carries references to whichever of its own attachments did save, because every attachment of a message is tried and one that fails does not keep the others from being saved. The transform raises the failure once the whole page has been written, so the sync job records it as its `transformError` and the page does not report as clean. As for every connector transform, the orchestrator does not run a failed transform again on its own. Processing the message again saves the file: the files already saved are reused, the missing one is tried again, and its reference is added to the stored message (next section). An attachment that stays unavailable keeps failing each time the message is processed, and the message keeps its other attachments.
- **Everything else.** A message that cannot be read, or that the filters drop, is skipped and logged. It does not fail the page and has no attachments to save.

## Messages that are already imported

The same message can arrive more than once: the inbox and sent sweeps overlap, a page can be sent again, and a mailbox can also have been imported from an archive. When the page write finds a message already stored, it refreshes only the few columns a re-sync may refresh, and the attachments are not among them. So the transform adds the references it just saved to the stored message, keeps the ones it already has, and does not add one twice. This is also how a message that was imported without an attachment gets it later.

This is not a backfill. Nothing here goes back through mail that was imported before attachments were supported, restarts a historical sync, or moves a connection's cursor. A message gains an attachment it was imported without only when it is processed again with its attachment data: by a later sync that fetches it, or by an operator running the transform of the page that holds it. Older mail that nobody processes again stays as it was imported.

## Removing

Forgetting a message removes its attachment records and any saved file that nothing else uses. Disconnecting a mailbox deletes the messages and attachment records that were imported only through it (a message that an archive import also delivered stays), as it does for other connectors. It does not delete the stored files: they stay in the owner's file library until they are deleted there or the account is deleted.

## What has been tested

The provider and storage tests cover authenticated retrieval and token renewal, nested Gmail parts, Outlook list paging (including ids that contain `=`) and inline-only images, mailbox separation, records kept without bytes, a message written without a file that failed and given it on the next run, and adding references to a stored message. They use synthetic mailboxes and responses, so they do not show that a live mailbox works end to end. Provider throttling, real attachment sizes and full document extraction have to be checked against a live Gmail or Outlook mailbox before these integrations are called verified.
