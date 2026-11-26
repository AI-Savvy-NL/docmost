import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('attachments')
    .addColumn('template_id', 'uuid', (col) =>
      col.references('templates.id').onDelete('restrict'),
    )
    .execute();
  await db.schema
    .createIndex('idx_attachments_template_id')
    .on('attachments')
    .column('template_id')
    .execute();
  await sql`
    ALTER TABLE attachments ADD CONSTRAINT attachments_template_owner_check
    CHECK (
      (template_id IS NULL AND type IS DISTINCT FROM 'wikisavvy-template')
      OR (
        template_id IS NOT NULL AND type IS NOT DISTINCT FROM 'wikisavvy-template'
        AND page_id IS NULL AND space_id IS NULL AND ai_chat_id IS NULL
      )
    )
  `.execute(db);
  await db.schema
    .createTable('wikisavvy_template_file_cleanup')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('operation_id', 'uuid', (col) => col.notNull())
    .addColumn('file_path', 'text', (col) => col.notNull().unique())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await db.schema
    .createIndex('idx_wikisavvy_template_file_cleanup_operation')
    .on('wikisavvy_template_file_cleanup')
    .column('operation_id')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const { rows } = await sql<{ pending: boolean }>`
    SELECT (
      EXISTS (SELECT 1 FROM attachments WHERE template_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM wikisavvy_template_file_cleanup)
    ) AS pending
  `.execute(db);
  if (rows[0].pending) {
    throw new Error(
      'Template files must be safely cleaned before reversing their ownership migration',
    );
  }
  await db.schema.dropTable('wikisavvy_template_file_cleanup').execute();
  await sql`ALTER TABLE attachments DROP CONSTRAINT attachments_template_owner_check`.execute(
    db,
  );
  await db.schema.dropIndex('idx_attachments_template_id').execute();
  await db.schema.alterTable('attachments').dropColumn('template_id').execute();
}
