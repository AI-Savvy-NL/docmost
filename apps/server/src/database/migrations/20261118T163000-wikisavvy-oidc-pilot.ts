import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('wikisavvy_oidc_providers')
    .addColumn('encrypted_client_secret', 'text')
    .addColumn('revision', 'integer', (c) => c.notNull().defaultTo(0))
    .execute();
  await db.schema
    .createTable('wikisavvy_oidc_transactions')
    .addColumn('state_hash', 'varchar(64)', (c) => c.primaryKey())
    .addColumn('workspace_id', 'uuid', (c) => c.notNull())
    .addColumn('provider_id', 'uuid', (c) => c.notNull())
    .addColumn('issuer', sql`varchar(2048) collate "C"`, (c) => c.notNull())
    .addColumn('browser_hash', 'varchar(64)', (c) => c.notNull())
    .addColumn('encrypted_payload', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addForeignKeyConstraint(
      'wikisavvy_oidc_transaction_provider_fk',
      ['provider_id', 'workspace_id', 'issuer'],
      'wikisavvy_oidc_providers',
      ['id', 'workspace_id', 'issuer'],
      (c) => c.onDelete('cascade'),
    )
    .execute();
  await db.schema
    .createIndex('wikisavvy_oidc_transaction_expiry_idx')
    .on('wikisavvy_oidc_transactions')
    .columns(['workspace_id', 'expires_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db
    .updateTable('wikisavvy_oidc_providers')
    .set({ is_enabled: false })
    .execute();
  await db.schema.dropTable('wikisavvy_oidc_transactions').execute();
  await db.schema
    .alterTable('wikisavvy_oidc_providers')
    .dropColumn('encrypted_client_secret')
    .dropColumn('revision')
    .execute();
}
