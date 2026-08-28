import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

/**
 * One file that arrived with a message.
 *
 * ## Why this type exists at all
 *
 * `ci.communications.attachments` has held the references since the table was
 * created and nothing could read them: `CommunicationType` had no such field,
 * so a correct column would still have shown a person nothing. It was also
 * never written — see `MediaStage.runAttachments` — which is why the gap went
 * unnoticed for as long as it did. Both halves are needed for a message to
 * actually show its photo.
 *
 * ## One entry per ATTACHMENT, not per reference
 *
 * The column stores a flat list in CI-Server's `{ type, id }` reference
 * vocabulary — every `file` ref, then every `content` ref. Those are two
 * handles on ONE thing: the file is the bytes, and the content row is the
 * catalogue entry that lets the same photo be found on its own rather than only
 * by reading the thread it arrived in. Surfacing them as two list entries would
 * make a gallery draw every Messenger photo twice, so the resolver pairs them
 * back up on the index alignment the writer guarantees.
 */
@ObjectType()
export class CommunicationAttachmentType {
  /**
   * The stored file, when this attachment's bytes were retained. Null for an
   * attachment catalogued without a file — a shape the writer does not produce
   * today, but the column is older than the writer and may hold anything.
   */
  @Field(() => ID, { nullable: true })
  fileId!: string | null;

  /** The `ci.content` row over the same bytes, for sources that catalogue them. */
  @Field(() => ID, { nullable: true })
  contentId!: string | null;

  /** The name the file had when the sender attached it. */
  @Field(() => String, { nullable: true })
  filename!: string | null;

  @Field(() => String, { nullable: true })
  contentType!: string | null;

  /** Signed URL for the original bytes. Null once the local copy is purged. */
  @Field(() => String, { nullable: true })
  url!: string | null;

  /** Signed URL for the thumbnail — the PREVIEW variant of the same file. */
  @Field(() => String, { nullable: true })
  previewUrl!: string | null;

  @Field(() => Int, { nullable: true })
  width!: number | null;

  @Field(() => Int, { nullable: true })
  height!: number | null;

  /** Bytes. `Float` because a video comfortably exceeds a 32-bit `Int`. */
  @Field(() => Float, { nullable: true })
  size!: number | null;
}
