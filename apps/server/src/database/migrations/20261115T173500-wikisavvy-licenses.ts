import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('wikisavvy_licenses')
    .addColumn('workspace_id', 'uuid', (c) =>
      c.primaryKey().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('encrypted_license', 'text', (c) => c.notNull())
    .addColumn('activated_by', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .addColumn('created_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createTable('wikisavvy_license_events')
    .addColumn('id', 'uuid', (c) =>
      c.primaryKey().defaultTo(sql`gen_random_uuid()`),
    )
    .addColumn('workspace_id', 'uuid', (c) =>
      c.notNull().references('workspaces.id').onDelete('cascade'),
    )
    .addColumn('actor_id', 'uuid', (c) =>
      c.references('users.id').onDelete('set null'),
    )
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('fingerprint', 'text')
    .addColumn('created_at', 'timestamptz', (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'wikisavvy_license_event_action',
      sql`action in ('activated', 'removed')`,
    )
    .execute();
  await db.schema
    .createIndex('wikisavvy_license_events_workspace_created_idx')
    .on('wikisavvy_license_events')
    .columns(['workspace_id', 'created_at'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('wikisavvy_license_events').execute();
  await db.schema.dropTable('wikisavvy_licenses').execute();
}
