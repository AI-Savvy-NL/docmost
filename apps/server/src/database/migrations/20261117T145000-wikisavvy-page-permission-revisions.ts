import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('wikisavvy_page_permission_revisions')
    .addColumn('page_id', 'uuid', (column) =>
      column.primaryKey().references('pages.id').onDelete('cascade'),
    )
    .addColumn('version', 'bigint', (column) => column.notNull().defaultTo(0))
    .addCheckConstraint(
      'wikisavvy_page_permission_version_nonnegative',
      sql`version >= 0`,
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('wikisavvy_page_permission_revisions').execute();
}
