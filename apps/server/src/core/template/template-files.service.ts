import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import { v7 as uuid7, validate as isUuid } from 'uuid';
import { sanitizeFileName } from '../../common/helpers/utils';
import { Cron } from '@nestjs/schedule';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { Attachment } from '@docmost/db/types/entity.types';
import { StorageService } from '../../integrations/storage/storage.service';
import { isAttachmentNode } from '../../common/helpers/prosemirror/attachment-node-types';

type SourceOwner =
  | { pageId: string; templateId?: never }
  | { templateId: string; pageId?: never };
type TargetOwner =
  | { pageId: string; spaceId: string; templateId?: never }
  | { templateId: string; pageId?: never; spaceId?: never };
type SnapshotCopy = {
  source: Attachment;
  id: string;
  filePath: string;
  fileName: string;
};
type SnapshotPlan = {
  operationId: string;
  source: SourceOwner;
  target: TargetOwner;
  actor: { id: string; workspaceId: string };
  content: any;
  copies: SnapshotCopy[];
};

@Injectable()
export class TemplateFilesService {
  private readonly logger = new Logger(TemplateFilesService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storage: StorageService,
  ) {}

  async prepare(
    content: any,
    source: SourceOwner,
    target: TargetOwner,
    actor: { id: string; workspaceId: string },
  ): Promise<SnapshotPlan> {
    const document = structuredClone(
      content ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    );
    if (document.type !== 'doc' || !Array.isArray(document.content)) {
      throw new BadRequestException('Invalid template document');
    }
    const nodes: any[] = [];
    const visit = (items: any[], depth = 0): any[] => {
      if (depth > 128)
        throw new BadRequestException('Template document is too deeply nested');
      return items.flatMap((node) => {
        if (!node || typeof node.type !== 'string')
          throw new BadRequestException('Invalid template node');
        if (node.type === 'transclusionReference') {
          throw new BadRequestException(
            'Resolve synced block references before creating a snapshot',
          );
        }
        if (node.content !== undefined) {
          if (!Array.isArray(node.content))
            throw new BadRequestException('Invalid template node content');
          node.content = visit(node.content, depth + 1);
        }
        if (node.type === 'transclusionSource') return node.content ?? [];
        if (node.marks !== undefined) {
          if (
            !Array.isArray(node.marks) ||
            node.marks.some(
              (mark: any) => !mark || typeof mark.type !== 'string',
            )
          ) {
            throw new BadRequestException('Invalid template marks');
          }
          node.marks = node.marks.filter(
            (mark: any) => mark.type !== 'comment',
          );
        }
        if (node.attrs?.attachmentId) {
          if (
            !isAttachmentNode(node.type) ||
            !isUuid(node.attrs.attachmentId)
          ) {
            throw new BadRequestException(
              'Invalid template attachment reference',
            );
          }
          nodes.push(node);
        } else if (isAttachmentNode(node.type)) {
          throw new BadRequestException(
            'Upload embedded files before creating a snapshot',
          );
        }
        return [node];
      });
    };
    document.content = visit(document.content);
    const ids = [
      ...new Set<string>(nodes.map((node) => node.attrs.attachmentId)),
    ];
    const copies: SnapshotCopy[] = [];
    for (const id of ids) {
      const attachment = await this.findSource(
        id,
        source,
        actor.workspaceId,
        this.db,
      );
      const newId = uuid7();
      const fileName = sanitizeFileName(attachment.fileName, {
        preserveSpaces: true,
      });
      if (!fileName) throw new BadRequestException('Invalid snapshot filename');
      const folder = target.templateId
        ? `templates/${target.templateId}`
        : 'files';
      const filePath = `${actor.workspaceId}/${folder}/${newId}/${fileName}`;
      copies.push({ source: attachment, id: newId, filePath, fileName });
      const route = target.templateId ? '/api/templates/files' : '/api/files';
      const url = `${route}/${newId}/${encodeURIComponent(fileName)}`;
      for (const node of nodes.filter(
        (node) => node.attrs.attachmentId === id,
      )) {
        node.attrs.attachmentId = newId;
        if ('src' in node.attrs) node.attrs.src = url;
        if ('url' in node.attrs) node.attrs.url = url;
      }
    }
    const operationId = uuid7();
    if (copies.length) {
      // Commit reservations before touching storage, so a process crash cannot
      // leave an untracked object after the main database transaction rolls back.
      await this.db
        .insertInto('wikisavvyTemplateFileCleanup')
        .values(
          copies.map((copy) => ({
            id: copy.id,
            operationId,
            filePath: copy.filePath,
          })),
        )
        .execute();
    }
    return { operationId, source, target, actor, content: document, copies };
  }

  async execute<T>(
    plan: SnapshotPlan,
    persist: (trx: KyselyTransaction, content: any) => Promise<T>,
    beforeCopy?: (trx: KyselyTransaction) => Promise<void>,
  ): Promise<T> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('wikisavvy-template-files'), hashtext(${plan.operationId}))`.execute(
          trx,
        );
        await beforeCopy?.(trx);
        for (const copy of plan.copies) {
          const reservation = await trx
            .selectFrom('wikisavvyTemplateFileCleanup')
            .select('id')
            .where('id', '=', copy.id)
            .where('operationId', '=', plan.operationId)
            .where('filePath', '=', copy.filePath)
            .executeTakeFirst();
          if (!reservation)
            throw new ConflictException('Snapshot reservation expired; retry');
          const source = await this.findSource(
            copy.source.id,
            plan.source,
            plan.actor.workspaceId,
            trx,
          );
          if (source.filePath !== copy.source.filePath) {
            throw new ConflictException('Source file changed; retry');
          }
          await this.storage.copy(source.filePath, copy.filePath);
          if (!(await this.storage.exists(copy.filePath))) {
            throw new ConflictException(
              'Snapshot file copy could not be verified',
            );
          }
          await trx
            .insertInto('attachments')
            .values({
              id: copy.id,
              workspaceId: plan.actor.workspaceId,
              creatorId: plan.actor.id,
              fileName: copy.fileName,
              filePath: copy.filePath,
              fileExt: source.fileExt,
              fileSize: source.fileSize,
              mimeType: source.mimeType,
              templateId: plan.target.templateId ?? null,
              pageId: plan.target.pageId ?? null,
              spaceId: plan.target.spaceId ?? null,
              type: plan.target.templateId ? 'wikisavvy-template' : 'file',
            })
            .execute();
        }
        return persist(trx, plan.content);
      });
    } finally {
      await this.cleanup(plan.operationId).catch(() => {
        this.logger.warn(
          'Snapshot cleanup deferred; durable reservations retained',
        );
      });
    }
  }

  async cleanup(operationId?: string): Promise<void> {
    let query = this.db
      .selectFrom('wikisavvyTemplateFileCleanup')
      .select('operationId')
      .distinct()
      .orderBy('operationId')
      .limit(100);
    if (operationId) query = query.where('operationId', '=', operationId);
    const operations = await query.execute();
    for (const operation of operations) {
      await this.db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ acquired: boolean }>`
          SELECT pg_try_advisory_xact_lock(hashtext('wikisavvy-template-files'), hashtext(${operation.operationId})) AS acquired
        `.execute(trx);
        if (!rows[0].acquired) return;
        const reservations = await trx
          .selectFrom('wikisavvyTemplateFileCleanup')
          .selectAll()
          .where('operationId', '=', operation.operationId)
          .execute();
        for (const reservation of reservations) {
          const retained = await trx
            .selectFrom('attachments')
            .select('id')
            .where('filePath', '=', reservation.filePath)
            .executeTakeFirst();
          if (!retained && (await this.storage.exists(reservation.filePath))) {
            await this.storage.delete(reservation.filePath);
          }
          await trx
            .deleteFrom('wikisavvyTemplateFileCleanup')
            .where('id', '=', reservation.id)
            .execute();
        }
      });
    }
  }

  @Cron('*/5 * * * *', { waitForCompletion: true })
  async sweep(): Promise<void> {
    await this.cleanup().catch(() => {
      this.logger.warn('Snapshot reservation cleanup deferred');
    });
    await this.cleanupRetired().catch(() => {
      this.logger.warn('Retired template file cleanup deferred');
    });
  }

  async cleanupRetired(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const retired = await trx
        .selectFrom('attachments')
        .select(['id', 'filePath'])
        .where('templateId', 'is not', null)
        .where('type', '=', 'wikisavvy-template')
        .where('deletedAt', 'is not', null)
        .orderBy('id')
        .limit(100)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const file of retired) {
        if (await this.storage.exists(file.filePath))
          await this.storage.delete(file.filePath);
        await trx.deleteFrom('attachments').where('id', '=', file.id).execute();
      }
    });
  }

  private async findSource(
    id: string,
    owner: SourceOwner,
    workspaceId: string,
    db: KyselyDB | KyselyTransaction,
  ): Promise<Attachment> {
    let query = db
      .selectFrom('attachments')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('aiChatId', 'is', null);
    if (owner.templateId) {
      query = query
        .where('templateId', '=', owner.templateId)
        .where('pageId', 'is', null)
        .where('type', '=', 'wikisavvy-template');
    } else {
      query = query
        .where('pageId', '=', owner.pageId)
        .where('templateId', 'is', null)
        .where('type', '=', 'file');
    }
    const attachment = await query.executeTakeFirst();
    if (!attachment) throw new NotFoundException('Snapshot file not found');
    return attachment;
  }
}
