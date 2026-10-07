import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'signup_code' })
export class SignupCodeEntity {
  /**
   * `bigint GENERATED ALWAYS AS IDENTITY`. Declared as generated so `save()` reads it back: as a
   * plain `@PrimaryColumn` a freshly minted code came back with no id, and `POST /signup-codes`
   * answered `"id": "undefined"`. A bigint, so it arrives as a string.
   */
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column({ unique: true })
  signup_code!: string;

  @Column()
  used!: boolean;

  /**
   * The account that issued this invitation, or null for one an operator minted (`make signup`)
   * and for every code that predates the column. A deleted account's unused codes are deleted with
   * it (`UserService.requestDeletion`).
   */
  @Column({ type: 'uuid', name: 'issued_by', nullable: true })
  issuedBy?: string | null;

  /** After this the code admits nobody, used or not. Defaults to a week after minting. */
  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type SignupCode = Readonly<SignupCodeEntity>;
