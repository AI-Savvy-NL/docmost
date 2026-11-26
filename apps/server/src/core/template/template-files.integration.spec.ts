import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import {
  up,
  down,
} from '../../database/migrations/20261125T180000-wikisavvy-template-files';
import { TemplateFilesService } from './template-files.service';
import { TemplateService } from './template.service';
import { TemplateRepo } from '../../database/repos/template/template.repo';
import { LocalDriver } from '../../integrations/storage/drivers/local.driver';
import { StorageService } from '../../integrations/storage/storage.service';

jest.mock('../page/services/page.service', () => ({ PageService: class {} }));

const url = process.env.WIKISAVVY_TEMPLATE_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration(
  'Template file ownership and recovery with isolated PostgreSQL',
  () => {
    let db: Kysely<any>;
    let service: TemplateFilesService;
    let templates: TemplateService;
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const sourcePageId = randomUUID();
    const targetPageId = randomUUID();
    const destinationSpaceId = randomUUID();
    const templateId = randomUUID();
    const attachmentId = randomUUID();
    const objects = new Map<string, Buffer>();
    const storage = {
      exists: jest.fn(async (path: string) => objects.has(path)),
      copy: jest.fn(async (from: string, to: string) => {
        if (!objects.has(from)) throw new Error('Missing fixture file');
        objects.set(to, Buffer.from(objects.get(from)));
      }),
      delete: jest.fn(async (path: string) => {
        objects.delete(path);
      }),
    };
    const content = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { attachmentId, src: `/api/files/${attachmentId}/source.png` },
        },
        {
          type: 'attachment',
          attrs: { attachmentId, url: `/api/files/${attachmentId}/source.png` },
        },
      ],
    };
    const source = { pageId: sourcePageId };
    const target = { templateId };
    const actor = { id: userId, workspaceId };
    const publisher = { assertCanPublish: jest.fn() };
    const pages = { create: jest.fn(), validateDocumentContent: jest.fn() };
    const pageRepo = {
      findById: jest.fn(),
      lockPageHierarchySpaces: jest.fn(),
    };
    const spaces = { findById: jest.fn() };
    const members = { getUserSpaceRoles: jest.fn() };
    const permissions = { canUserEditPage: jest.fn() };
    const audit = { log: jest.fn() };

    async function copy(body = content, from = source, to = target) {
      const plan = await service.prepare(body, from, to, {
        id: userId,
        workspaceId,
      });
      return service.execute(plan, async (trx, snapshot) => {
        await dbOrTrxTemplate(trx, snapshot);
        return snapshot;
      });
    }
    async function dbOrTrxTemplate(trx: Kysely<any>, snapshot: any) {
      await trx
        .updateTable('templates')
        .set({ content: snapshot })
        .where('id', '=', templateId)
        .execute();
    }

    beforeAll(async () => {
      const parsed = new URL(url);
      if (
        parsed.hostname !== '127.0.0.1' ||
        parsed.pathname !== '/wikisavvy_template_test'
      ) {
        throw new Error('Refusing a non-local template test database');
      }
      db = new Kysely({
        dialect: new PostgresJSDialect({
          postgres: postgres(url, { max: 5, onnotice: () => {} }),
        }),
        plugins: [new CamelCasePlugin()],
      });
      await sql`CREATE SCHEMA template_files_fixture`.execute(db);
      // Every pooled connection must use the isolated fixture schema.
      await db.destroy();
      db = new Kysely({
        dialect: new PostgresJSDialect({
          postgres: postgres(url, {
            max: 5,
            onnotice: () => {},
            connection: { search_path: 'template_files_fixture,public' },
          }),
        }),
        plugins: [new CamelCasePlugin()],
      });
      await db.schema
        .createTable('templates')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('workspaceId', 'uuid')
        .addColumn('deletedAt', 'timestamptz')
        .addColumn('title', 'varchar')
        .addColumn('description', 'text')
        .addColumn('icon', 'varchar')
        .addColumn('creatorId', 'uuid')
        .addColumn('lastUpdatedById', 'uuid')
        .addColumn('spaceId', 'uuid')
        .addColumn('createdAt', 'timestamptz', (c) => c.defaultTo(sql`now()`))
        .addColumn('updatedAt', 'timestamptz', (c) => c.defaultTo(sql`now()`))
        .addColumn('content', 'jsonb')
        .execute();
      await db.schema
        .createTable('users')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('workspaceId', 'uuid')
        .addColumn('role', 'varchar')
        .addColumn('name', 'varchar')
        .addColumn('avatarUrl', 'varchar')
        .addColumn('deletedAt', 'timestamptz')
        .addColumn('deactivatedAt', 'timestamptz')
        .execute();
      await db.schema
        .createTable('attachments')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('workspaceId', 'uuid')
        .addColumn('creatorId', 'uuid')
        .addColumn('pageId', 'uuid')
        .addColumn('spaceId', 'uuid')
        .addColumn('aiChatId', 'uuid')
        .addColumn('filePath', 'varchar')
        .addColumn('fileName', 'varchar')
        .addColumn('fileExt', 'varchar')
        .addColumn('fileSize', 'int8')
        .addColumn('mimeType', 'varchar')
        .addColumn('type', 'varchar')
        .addColumn('deletedAt', 'timestamptz')
        .execute();
      await up(db);
      service = new TemplateFilesService(db as any, storage as any);
      templates = new TemplateService(
        db as any,
        new TemplateRepo(db as any),
        service,
        publisher as any,
        pages as any,
        pageRepo as any,
        spaces as any,
        members as any,
        permissions as any,
        audit as any,
      );
    });

    afterAll(async () => {
      await db?.destroy();
    });
    beforeEach(async () => {
      jest.clearAllMocks();
      objects.clear();
      storage.copy.mockImplementation(async (from, to) => {
        if (!objects.has(from)) throw new Error('Missing fixture file');
        objects.set(to, Buffer.from(objects.get(from)));
      });
      storage.delete.mockImplementation(async (path) => {
        objects.delete(path);
      });
      await db.deleteFrom('attachments').execute();
      await db.deleteFrom('templates').execute();
      await db.deleteFrom('wikisavvyTemplateFileCleanup').execute();
      await db.deleteFrom('users').execute();
      await db
        .insertInto('users')
        .values({ id: userId, workspaceId, role: 'member' })
        .execute();
      await db
        .insertInto('templates')
        .values({ id: templateId, workspaceId })
        .execute();
      objects.set('source/file.png', Buffer.from('original bytes'));
      await db
        .insertInto('attachments')
        .values({
          id: attachmentId,
          workspaceId,
          creatorId: userId,
          pageId: sourcePageId,
          spaceId: randomUUID(),
          filePath: 'source/file.png',
          fileName: 'source.png',
          fileExt: '.png',
          mimeType: 'image/png',
          type: 'file',
          fileSize: 14,
        })
        .execute();
      publisher.assertCanPublish.mockResolvedValue({
        id: sourcePageId,
        workspaceId,
        spaceId: randomUUID(),
        title: 'Saved page',
        icon: null,
        content,
        textContent: '',
      });
      pageRepo.lockPageHierarchySpaces.mockResolvedValue(undefined);
      spaces.findById.mockResolvedValue({
        id: destinationSpaceId,
        workspaceId,
        deletedAt: null,
        archivedAt: null,
      });
      members.getUserSpaceRoles.mockResolvedValue([{ role: 'writer' }]);
      permissions.canUserEditPage.mockResolvedValue({
        hasAnyRestriction: false,
        canAccess: true,
        canEdit: true,
      });
      pages.create.mockImplementation(
        async (_user, _ws, dto, _trx, _base, id) => ({ id, ...dto }),
      );
      pages.validateDocumentContent.mockResolvedValue(undefined);
    });

    it('preserves old page-file ownership after the nullable migration', async () => {
      const old = await db
        .selectFrom('attachments')
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(old.templateId).toBeNull();
      expect(old.pageId).toBe(sourcePageId);
    });

    it('copies one independent file for repeated references and rewrites src and url', async () => {
      const snapshot = await copy();
      const nodes = snapshot.content;
      const id = nodes[0].attrs.attachmentId;
      expect(id).not.toBe(attachmentId);
      expect(nodes[1].attrs.attachmentId).toBe(id);
      expect(nodes[0].attrs.src).toBe(`/api/templates/files/${id}/source.png`);
      expect(nodes[1].attrs.url).toBe(`/api/templates/files/${id}/source.png`);
      expect(content.content[0].attrs.attachmentId).toBe(attachmentId);
      expect(storage.copy).toHaveBeenCalledTimes(1);
      const owned = await db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(owned).toMatchObject({
        templateId,
        pageId: null,
        spaceId: null,
        aiChatId: null,
        type: 'wikisavvy-template',
      });
      objects.delete('source/file.png');
      await db
        .deleteFrom('attachments')
        .where('id', '=', attachmentId)
        .execute();
      expect(objects.get(owned.filePath)?.toString()).toBe('original bytes');
    });

    it('refuses cross-workspace references before copying bytes', async () => {
      await db
        .updateTable('attachments')
        .set({ workspaceId: randomUUID() })
        .execute();
      await expect(copy()).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.copy).not.toHaveBeenCalled();
    });

    it('refuses a file owned by a different page even when its ID occurs in the source JSON', async () => {
      await db
        .updateTable('attachments')
        .set({ pageId: randomUUID() })
        .execute();
      await expect(copy()).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses deleted files and leaves no partial snapshot', async () => {
      await db
        .updateTable('attachments')
        .set({ deletedAt: new Date() })
        .execute();
      await expect(copy()).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.copy).not.toHaveBeenCalled();
    });

    it('does not fall back to a source URL when a file is missing', async () => {
      objects.clear();
      await expect(copy()).rejects.toThrow('Missing fixture file');
      expect(
        await db
          .selectFrom('attachments')
          .selectAll()
          .where('templateId', '=', templateId)
          .execute(),
      ).toEqual([]);
    });

    it('refuses to publish when a storage driver silently skips a missing copy source', async () => {
      storage.copy.mockImplementationOnce(async () => undefined);
      await expect(copy()).rejects.toThrow('could not be verified');
      expect(
        await db
          .selectFrom('attachments')
          .selectAll()
          .where('templateId', '=', templateId)
          .execute(),
      ).toEqual([]);
    });

    it('preserves real local-storage bytes independently after deleting the source object', async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'wikisavvy-template-files-'),
      );
      const driver = new LocalDriver({ storagePath: directory });
      const local = new TemplateFilesService(
        db as any,
        new StorageService(driver),
      );
      try {
        await driver.upload(
          'source/file.png',
          Buffer.from('real durable bytes'),
        );
        const plan = await local.prepare(content, source, target, actor);
        const body = await local.execute(plan, async (trx, snapshot) => {
          await dbOrTrxTemplate(trx, snapshot);
          return snapshot;
        });
        await driver.delete('source/file.png');
        const file = await db
          .selectFrom('attachments')
          .selectAll()
          .where('id', '=', body.content[0].attrs.attachmentId)
          .executeTakeFirstOrThrow();
        expect((await driver.read(file.filePath)).toString()).toBe(
          'real durable bytes',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('catches the real LocalDriver no-op when its source object is missing', async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'wikisavvy-template-files-'),
      );
      const driver = new LocalDriver({ storagePath: directory });
      const local = new TemplateFilesService(
        db as any,
        new StorageService(driver),
      );
      try {
        const plan = await local.prepare(content, source, target, actor);
        await expect(
          local.execute(plan, async (_trx, body) => body),
        ).rejects.toThrow('could not be verified');
        expect(
          await db
            .selectFrom('attachments')
            .selectAll()
            .where('templateId', '=', templateId)
            .execute(),
        ).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('recovers abandoned physical copies from the durable journal after a service restart', async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'wikisavvy-template-files-'),
      );
      const driver = new LocalDriver({ storagePath: directory });
      const storageService = new StorageService(driver);
      try {
        const local = new TemplateFilesService(db as any, storageService);
        const plan = await local.prepare(content, source, target, actor);
        const reserved = await db
          .selectFrom('wikisavvyTemplateFileCleanup')
          .selectAll()
          .where('operationId', '=', plan.operationId)
          .executeTakeFirstOrThrow();
        await driver.upload(
          reserved.filePath,
          Buffer.from('abandoned partial bytes'),
        );
        await new TemplateFilesService(db as any, storageService).cleanup();
        expect(await driver.exists(reserved.filePath)).toBe(false);
        expect(
          await db
            .selectFrom('wikisavvyTemplateFileCleanup')
            .selectAll()
            .execute(),
        ).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('refuses NULL type for a template-owned file at the database boundary', async () => {
      await expect(
        db
          .updateTable('attachments')
          .set({
            templateId,
            type: null,
            pageId: null,
            spaceId: null,
          })
          .where('id', '=', attachmentId)
          .execute(),
      ).rejects.toThrow();
    });

    it('validates edited documents before making storage reservations', async () => {
      const created = await templates.create(actor, { title: 'Safe' });
      pages.validateDocumentContent.mockRejectedValueOnce(
        new BadRequestException('Invalid content format'),
      );
      await expect(
        templates.update(actor, {
          templateId: created.id,
          content: { type: 'doc', content: [{ type: 'unsupported' }] },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await db
          .selectFrom('wikisavvyTemplateFileCleanup')
          .selectAll()
          .execute(),
      ).toEqual([]);
    });

    it('journals partial storage writes and retries cleanup after failure', async () => {
      storage.copy.mockImplementationOnce(async (_from, to) => {
        objects.set(to, Buffer.from('partial'));
        throw new Error('copy interrupted');
      });
      storage.delete.mockRejectedValueOnce(new Error('storage unavailable'));
      await expect(copy()).rejects.toThrow('copy interrupted');
      expect(
        await db
          .selectFrom('wikisavvyTemplateFileCleanup')
          .selectAll()
          .execute(),
      ).toHaveLength(1);
      await service.cleanup();
      expect(
        await db
          .selectFrom('wikisavvyTemplateFileCleanup')
          .selectAll()
          .execute(),
      ).toEqual([]);
      expect([...objects.keys()]).toEqual(['source/file.png']);
    });

    it('rolls back attachment rows and file bytes when persistence refuses the snapshot', async () => {
      const plan = await service.prepare(content, source, target, {
        id: userId,
        workspaceId,
      });
      await expect(
        service.execute(plan, async () => {
          throw new Error('authorization revoked');
        }),
      ).rejects.toThrow('authorization revoked');
      expect(
        await db
          .selectFrom('attachments')
          .selectAll()
          .where('templateId', '=', templateId)
          .execute(),
      ).toEqual([]);
      expect([...objects.keys()]).toEqual(['source/file.png']);
    });

    it('does not delete successful files while pruning the cleanup journal', async () => {
      await copy();
      await service.cleanup();
      expect(objects.size).toBe(2);
      expect(
        await db
          .selectFrom('wikisavvyTemplateFileCleanup')
          .selectAll()
          .execute(),
      ).toEqual([]);
    });

    it('skips cleanup while a copy transaction holds the operation lock', async () => {
      let release: () => void;
      let entered: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const copying = new Promise<void>((resolve) => {
        entered = resolve;
      });
      storage.copy.mockImplementationOnce(async (from, to) => {
        objects.set(to, Buffer.from(objects.get(from)));
        entered();
        await gate;
      });
      const pending = copy();
      await copying;
      try {
        await service.cleanup();
        expect(storage.delete).not.toHaveBeenCalled();
        expect(
          await db
            .selectFrom('wikisavvyTemplateFileCleanup')
            .selectAll()
            .execute(),
        ).toHaveLength(1);
      } finally {
        release();
        await pending;
      }
      expect(objects.size).toBe(2);
    });

    it('rechecks source ownership after preparation and before copying', async () => {
      const plan = await service.prepare(content, source, target, {
        id: userId,
        workspaceId,
      });
      await db
        .updateTable('attachments')
        .set({ pageId: randomUUID() })
        .where('id', '=', attachmentId)
        .execute();
      await expect(
        service.execute(plan, async (_trx, body) => body),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.copy).not.toHaveBeenCalled();
    });

    it('refuses migration reversal while owned files still exist', async () => {
      await copy();
      await expect(down(db)).rejects.toThrow('safely cleaned');
      expect(objects.size).toBe(2);
    });

    it('refuses external media instead of promising a durable snapshot of a hotlink', async () => {
      await expect(
        copy({
          type: 'doc',
          content: [
            { type: 'image', attrs: { src: 'https://example.com/image.png' } },
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.copy).not.toHaveBeenCalled();
    });

    it('refuses mixed template/page ownership at the database boundary', async () => {
      await expect(
        db
          .updateTable('attachments')
          .set({
            templateId,
            type: 'wikisavvy-template',
          })
          .where('id', '=', attachmentId)
          .execute(),
      ).rejects.toThrow();
    });

    it('refuses hard template deletion while owned files still need cleanup', async () => {
      await copy();
      await expect(
        db.deleteFrom('templates').where('id', '=', templateId).execute(),
      ).rejects.toThrow();
    });

    it('copies template-owned bytes to independent target-page ownership', async () => {
      const snapshot = await copy();
      const plan = await service.prepare(
        snapshot,
        { templateId },
        { pageId: targetPageId, spaceId: randomUUID() },
        { id: userId, workspaceId },
      );
      const page = await service.execute(plan, async (_trx, body) => body);
      const file = await db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', page.content[0].attrs.attachmentId)
        .executeTakeFirstOrThrow();
      expect(file).toMatchObject({
        pageId: targetPageId,
        templateId: null,
        type: 'file',
      });
      expect(page.content[0].attrs.src).toMatch(/^\/api\/files\//);
      const templateFiles = await db
        .selectFrom('attachments')
        .selectAll()
        .where('templateId', '=', templateId)
        .execute();
      for (const templateFile of templateFiles)
        objects.delete(templateFile.filePath);
      expect(objects.get(file.filePath)?.toString()).toBe('original bytes');
    });

    it('does not reuse a cleanup reservation after a cleaner has reclaimed it', async () => {
      const plan = await service.prepare(content, source, target, {
        id: userId,
        workspaceId,
      });
      await service.cleanup();
      await expect(
        service.execute(plan, async (_trx, body) => body),
      ).rejects.toThrow();
      expect(storage.copy).not.toHaveBeenCalled();
    });

    it('rejects unresolved synced references rather than publishing a live restricted reference', async () => {
      await expect(
        copy({
          type: 'doc',
          content: [
            {
              type: 'transclusionReference',
              attrs: { transclusionId: randomUUID() },
            },
          ],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('publishes a page snapshot and independently owned files atomically', async () => {
      const created = await templates.create(actor, {
        sourcePageId,
        title: 'Reusable',
      });
      expect(created).toMatchObject({
        title: 'Reusable',
        spaceId: null,
        creatorId: userId,
        canManage: true,
      });
      const files = await db
        .selectFrom('attachments')
        .selectAll()
        .where('templateId', '=', created.id)
        .execute();
      expect(files).toHaveLength(1);
      expect(publisher.assertCanPublish).toHaveBeenCalledTimes(3);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'template.created',
          metadata: { sourcePageId },
        }),
      );
      expect(JSON.stringify(audit.log.mock.calls)).not.toContain(
        'original bytes',
      );
      expect(JSON.stringify(audit.log.mock.calls)).not.toContain('/api/files');
    });

    it('refuses publication when source permission is revoked during copying', async () => {
      const snapshot = {
        id: sourcePageId,
        workspaceId,
        title: 'Saved page',
        content,
      };
      publisher.assertCanPublish
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValueOnce(snapshot)
        .mockRejectedValue(new NotFoundException());
      await expect(
        templates.create(actor, { sourcePageId }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await db
          .selectFrom('templates')
          .selectAll()
          .where('id', '!=', templateId)
          .execute(),
      ).toEqual([]);
      expect([...objects.keys()]).toEqual(['source/file.png']);
      expect(storage.copy).toHaveBeenCalledTimes(1);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('allows all members to create an empty template and update its text', async () => {
      const created = await templates.create(actor, { title: 'Blank' });
      const changed = await templates.update(actor, {
        templateId: created.id,
        title: 'Edited',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Reusable text' }],
            },
          ],
        },
      });
      expect(changed.title).toBe('Edited');
      expect(changed.content.content[0].content[0].text).toBe('Reusable text');
      expect(publisher.assertCanPublish).not.toHaveBeenCalled();
    });

    it('prevents non-authors from managing another member’s template', async () => {
      const created = await templates.create(actor, { title: 'Owned' });
      const other = { id: randomUUID(), workspaceId };
      await db
        .insertInto('users')
        .values({ ...other, role: 'member' })
        .execute();
      await expect(
        templates.update(other, { templateId: created.id, title: 'Stolen' }),
      ).rejects.toThrow();
      await expect(templates.remove(other, created.id)).rejects.toThrow();
      expect((await templates.info(other, created.id)).canManage).toBe(false);
    });

    it('allows a persisted admin to manage a template and hides soft-deleted templates', async () => {
      const created = await templates.create(actor, { sourcePageId });
      const admin = { id: randomUUID(), workspaceId };
      await db
        .insertInto('users')
        .values({ ...admin, role: 'admin' })
        .execute();
      await templates.remove(admin, created.id);
      await expect(templates.info(actor, created.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const listing = await templates.list(actor, { limit: 20 } as any);
      expect(listing.items.map((item) => item.id)).not.toContain(created.id);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'template.deleted' }),
      );
    });

    it('copies files on use and enforces destination write access', async () => {
      const created = await templates.create(actor, { sourcePageId });
      const page = await templates.use(actor, {
        templateId: created.id,
        spaceId: destinationSpaceId,
      });
      const file = await db
        .selectFrom('attachments')
        .selectAll()
        .where('pageId', '=', page.id)
        .executeTakeFirstOrThrow();
      expect(file.templateId).toBeNull();
      expect(file.type).toBe('file');
      members.getUserSpaceRoles.mockResolvedValue([{ role: 'reader' }]);
      await expect(
        templates.use(actor, {
          templateId: created.id,
          spaceId: destinationSpaceId,
        }),
      ).rejects.toThrow();
      expect(pages.create).toHaveBeenCalledTimes(1);
    });

    it('refuses an inaccessible destination parent even when the space is writable', async () => {
      const created = await templates.create(actor, { title: 'Safe' });
      pageRepo.findById.mockResolvedValue({
        id: randomUUID(),
        spaceId: destinationSpaceId,
        workspaceId,
      });
      permissions.canUserEditPage.mockResolvedValue({
        hasAnyRestriction: true,
        canAccess: false,
        canEdit: false,
      });
      await expect(
        templates.use(actor, {
          templateId: created.id,
          spaceId: destinationSpaceId,
          parentPageId: randomUUID(),
        }),
      ).rejects.toThrow();
      expect(pages.create).not.toHaveBeenCalled();
    });

    it('denies cross-workspace template reads, edits and use', async () => {
      const created = await templates.create(actor, {
        title: 'Private workspace',
      });
      const other = { id: randomUUID(), workspaceId: randomUUID() };
      await db
        .insertInto('users')
        .values({ ...other, role: 'admin' })
        .execute();
      await expect(templates.info(other, created.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        templates.update(other, { templateId: created.id, title: 'No' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        templates.use(other, {
          templateId: created.id,
          spaceId: destinationSpaceId,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('prepares page-owned copies for the existing empty-page picker', async () => {
      const created = await templates.create(actor, { sourcePageId });
      pageRepo.findById.mockResolvedValue({
        id: targetPageId,
        spaceId: destinationSpaceId,
        workspaceId,
      });
      const prepared = await templates.prepareForPage(actor, {
        templateId: created.id,
        pageId: targetPageId,
      });
      expect(prepared.title).toBe('Saved page');
      const file = await db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', prepared.content.content[0].attrs.attachmentId)
        .executeTakeFirstOrThrow();
      expect(file).toMatchObject({
        pageId: targetPageId,
        spaceId: destinationSpaceId,
        templateId: null,
      });
      expect(pages.create).not.toHaveBeenCalled();
    });

    it('denies empty-page preparation when its current page is locked', async () => {
      const created = await templates.create(actor, { title: 'Safe' });
      pageRepo.findById.mockResolvedValue({
        id: targetPageId,
        spaceId: destinationSpaceId,
        workspaceId,
        isLocked: true,
      });
      await expect(
        templates.prepareForPage(actor, {
          templateId: created.id,
          pageId: targetPageId,
        }),
      ).rejects.toThrow();
    });

    it('cleans retired template files with retry while leaving source and target-page files alone', async () => {
      const created = await templates.create(actor, { sourcePageId });
      const page = await templates.use(actor, {
        templateId: created.id,
        spaceId: destinationSpaceId,
      });
      await templates.remove(actor, created.id);
      storage.delete.mockRejectedValueOnce(new Error('cleanup unavailable'));
      await expect(service.cleanupRetired()).rejects.toThrow(
        'cleanup unavailable',
      );
      await service.cleanupRetired();
      expect(
        await db
          .selectFrom('attachments')
          .selectAll()
          .where('templateId', '=', created.id)
          .execute(),
      ).toEqual([]);
      const retained = await db
        .selectFrom('attachments')
        .selectAll()
        .where('pageId', '=', page.id)
        .executeTakeFirstOrThrow();
      expect(objects.get(retained.filePath)?.toString()).toBe('original bytes');
      expect(objects.has('source/file.png')).toBe(true);
    });

    it('rejects stale-editor saves using the supplied update timestamp', async () => {
      const created = await templates.create(actor, { title: 'Original' });
      await db
        .updateTable('templates')
        .set({ updatedAt: new Date(Date.now() + 1000) })
        .where('id', '=', created.id)
        .execute();
      await expect(
        templates.update(actor, {
          templateId: created.id,
          title: 'Stale',
          expectedUpdatedAt: new Date(created.updatedAt).toISOString(),
        }),
      ).rejects.toThrow('Template changed');
    });

    it('requires an active same-workspace account for template file reads and hides deleted templates', async () => {
      const created = await templates.create(actor, { sourcePageId });
      const fileId = created.content.content[0].attrs.attachmentId;
      expect((await templates.file(actor, fileId)).workspaceId).toBe(
        workspaceId,
      );
      await templates.remove(actor, created.id);
      await expect(templates.file(actor, fileId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await db
        .updateTable('users')
        .set({ deactivatedAt: new Date() })
        .where('id', '=', userId)
        .execute();
      await expect(
        templates.list(actor, { limit: 20 } as any),
      ).rejects.toThrow();
    });

    it('can reverse the migration after template files have been removed', async () => {
      await db.deleteFrom('attachments').execute();
      await down(db);
      await up(db);
      const { rows } = await sql<{ exists: boolean }>`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'template_files_fixture'
        AND table_name = 'attachments' AND column_name = 'template_id'
    ) AS exists`.execute(db);
      expect(rows[0].exists).toBe(true);
    });
  },
);
