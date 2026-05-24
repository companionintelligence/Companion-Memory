import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity({ schema: 'ci', name: 'signup_code' })
export class SignupCodeEntity {
  @PrimaryColumn()
  id!: string;

  @Column({ unique: true })
  signup_code!: string;

  @Column()
  used!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type SignupCode = Readonly<SignupCodeEntity>;
