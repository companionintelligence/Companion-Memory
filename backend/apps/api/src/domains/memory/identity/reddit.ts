import { platformIdentity } from './registry';
import type { SourceIdentity } from './types';

/**
 * Reddit platform-kind identities (docs/design/cross-pipeline-identity.md
 * §3.2), minted here for BOTH pipelines: the OAuth connection's listing sync
 * and the GDPR-export CSV importer.
 *
 * The id is `reddit:<kind>:<bare id>` under the canonical `reddit` system. The
 * leading `reddit:` looks redundant next to `source_system = 'reddit'`, and it
 * is — it is the spelling the importer has stamped as its staged item id since
 * before the registry existed. That id is the staged row's `content_hash`, and
 * so the `source_id` of every row the importer has already written; changing
 * it would turn the next re-import of the same archive into a second copy of
 * everything. The connection adopts the importer's spelling instead.
 *
 * The bare id is Reddit's base-36 thing id WITHOUT the type prefix (`xfkamy`,
 * not `t3_xfkamy`). The export CSVs carry it bare; the API carries it bare as
 * `id` and prefixed as `name` (the "fullname"). Either spelling is accepted so
 * a caller holding only the fullname still lands on the same key.
 *
 * The kind carries the authored/saved distinction (`post` vs `saved_post`)
 * because both exports do: saving someone else's post is a different record
 * from writing one, and the same post can legitimately be both.
 */
export type RedditRecordKind = 'post' | 'comment' | 'saved_post' | 'saved_comment';

/** Reddit's fullname prefixes: t1 comment, t2 account, t3 link, t4 message, t5 subreddit, t6 award. */
const FULLNAME_PREFIX = /^t[1-6]_/;

/** `t3_xfkamy` → `xfkamy`; anything without a fullname prefix passes through unchanged. */
export function redditBareId(idOrFullname: string): string {
  return idOrFullname.replace(FULLNAME_PREFIX, '');
}

/** Is this a comment fullname (`t1_…`)? Saved listings mix posts and comments; this tells them apart. */
export function isRedditCommentFullname(fullname: string): boolean {
  return fullname.startsWith('t1_');
}

/**
 * The importer's staged item id for a Reddit record — and, verbatim, the
 * `source_id` both pipelines key on. `id` may be a bare id, a fullname, or
 * (importer fallback when the CSV row has no id) a permalink.
 */
export function redditRecordId(kind: RedditRecordKind, id: string): string {
  return `reddit:${kind}:${redditBareId(id)}`;
}

/** The full (system, id) pair for a Reddit post or comment, authored or saved. */
export function redditIdentity(kind: RedditRecordKind, id: string): SourceIdentity {
  return platformIdentity('reddit', redditRecordId(kind, id));
}
