import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addUniqueConstraint('wikisavvy_oidc_user_workspace_unique', [
      'id',
      'workspace_id',
    ])
    .execute();
  await db.schema
    .createTable('wikisavvy_oidc_providers')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('workspace_id', 'uuid', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('issuer', sql`varchar(2048) collate "C"`, (c) => c.notNull())
    .addColumn('client_id', 'varchar(512)', (c) => c.notNull())
    .addColumn('is_enabled', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'wikisavvy_oidc_provider_issuer_nonempty',
      sql`length(issuer) > 0`,
    )
    .addCheckConstraint(
      'wikisavvy_oidc_provider_client_nonempty',
      sql`length(btrim(client_id)) > 0`,
    )
    .addUniqueConstraint('wikisavvy_oidc_provider_workspace_issuer_unique', [
      'id',
      'workspace_id',
      'issuer',
    ])
    .execute();
  await db.schema
    .createTable('wikisavvy_oidc_identities')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('workspace_id', 'uuid', (c) => c.notNull())
    .addColumn('provider_id', 'uuid', (c) => c.notNull())
    .addColumn('issuer', sql`varchar(2048) collate "C"`, (c) => c.notNull())
    .addColumn('subject', sql`varchar(255) collate "C"`, (c) => c.notNull())
    .addColumn('user_id', 'uuid', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'wikisavvy_oidc_identity_subject_nonempty',
      sql`length(subject) > 0`,
    )
    .addForeignKeyConstraint(
      'wikisavvy_oidc_identity_provider_fk',
      ['provider_id', 'workspace_id', 'issuer'],
      'wikisavvy_oidc_providers',
      ['id', 'workspace_id', 'issuer'],
      (c) => c.onDelete('cascade'),
    )
    .addForeignKeyConstraint(
      'wikisavvy_oidc_identity_user_fk',
      ['user_id', 'workspace_id'],
      'users',
      ['id', 'workspace_id'],
      (c) => c.onDelete('cascade'),
    )
    .addUniqueConstraint('wikisavvy_oidc_identity_issuer_subject_unique', [
      'workspace_id',
      'issuer',
      'subject',
    ])
    .addUniqueConstraint('wikisavvy_oidc_identity_user_provider_unique', [
      'user_id',
      'provider_id',
    ])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('wikisavvy_oidc_identities').execute();
  await db.schema.dropTable('wikisavvy_oidc_providers').execute();
  await db.schema
    .alterTable('users')
    .dropConstraint('wikisavvy_oidc_user_workspace_unique')
    .execute();
}
