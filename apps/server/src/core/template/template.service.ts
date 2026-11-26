import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { v7 as uuid7 } from 'uuid';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import { TemplateRepo } from '@docmost/db/repos/template/template.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PaginationOptions } from '@docmost/db/pagination/pagination-options';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { TemplateFilesService } from './template-files.service';
import {
  TemplatePublicationPolicy,
  TemplateSourceSnapshot,
} from './template-publication-policy';
import { PageService } from '../page/services/page.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';

type Actor = { id: string; workspaceId: string };
type TemplateEdit = {
  title?: string;
  description?: string;
  icon?: string;
  content?: any;
  expectedUpdatedAt?: string;
};
type CreateTemplate = TemplateEdit & {
  sourcePageId?: string;
  confirmRestrictedSource?: boolean;
};
type UseTemplate = {
  templateId: string;
  spaceId: string;
  parentPageId?: string;
};

@Injectable()
export class TemplateService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly repo: TemplateRepo,
    private readonly files: TemplateFilesService,
    private readonly publication: TemplatePublicationPolicy,
    private readonly pages: PageService,
    private readonly pageRepo: PageRepo,
    private readonly spaces: SpaceRepo,
    private readonly members: SpaceMemberRepo,
    private readonly permissions: PagePermissionRepo,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  async list(actor: Actor, pagination: PaginationOptions) {
    const user = await this.requireActor(actor);
    const result = await this.repo.findTemplates(
      actor.workspaceId,
      [],
      pagination,
    );
    return {
      ...result,
      items: result.items.map((row) => this.view(row, user)),
    };
  }

  async info(actor: Actor, id: string) {
    return this.db.transaction().execute(async (trx) => {
      const user = await this.requireActor(actor, trx);
      const template = await this.find(actor, id, trx);
      return this.view(template, user);
    });
  }

  async create(actor: Actor, input: CreateTemplate) {
    await this.requireActor(actor);
    const initial = input.sourcePageId
      ? await this.db
          .transaction()
          .execute((trx) =>
            this.publication.assertCanPublish(
              actor,
              input.sourcePageId,
              input.confirmRestrictedSource === true,
              trx,
            ),
          )
      : undefined;
    const id = uuid7();
    const body =
      initial?.content ?? (input.sourcePageId ? null : input.content);
    await this.pages.validateDocumentContent(
      body ?? { type: 'doc', content: [{ type: 'paragraph' }] },
    );
    const plan = await this.files.prepare(
      body,
      { pageId: input.sourcePageId ?? id },
      { templateId: id },
      actor,
    );
    const validateSource = async (trx: KyselyTransaction) => {
      if (!initial) return;
      await this.pageRepo.lockPageHierarchySpaces([initial.spaceId], trx);
      const current = await this.publication.assertCanPublish(
        actor,
        input.sourcePageId,
        input.confirmRestrictedSource === true,
        trx,
      );
      this.assertSourceUnchanged(initial, current);
    };
    const created = await this.files.execute(
      plan,
      async (trx, content) => {
        const user = await this.requireActor(actor, trx);
        await validateSource(trx);
        await this.pages.validateDocumentContent(content);
        await this.repo.updateTemplate({ content }, id, actor.workspaceId, trx);
        return this.view(await this.find(actor, id, trx), user);
      },
      async (trx) => {
        await this.requireActor(actor, trx);
        await validateSource(trx);
        await this.repo.insertTemplate(
          {
            id,
            workspaceId: actor.workspaceId,
            spaceId: null,
            title: input.title ?? initial?.title ?? 'Untitled',
            description: input.description,
            icon: input.icon ?? initial?.icon,
            creatorId: actor.id,
            lastUpdatedById: actor.id,
          },
          trx,
        );
      },
    );
    await this.audit.log({
      event: AuditEvent.TEMPLATE_CREATED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: id,
      metadata: input.sourcePageId ? { sourcePageId: input.sourcePageId } : {},
    });
    return created;
  }

  async update(actor: Actor, input: TemplateEdit & { templateId: string }) {
    const previous = await this.info(actor, input.templateId);
    if (!previous.canManage) throw new ForbiddenException();
    if (
      input.expectedUpdatedAt &&
      new Date(input.expectedUpdatedAt).getTime() !==
        new Date(previous.updatedAt).getTime()
    ) {
      throw new ConflictException('Template changed; reload before saving');
    }
    const persist = async (trx: KyselyTransaction, content?: any) => {
      const user = await this.requireActor(actor, trx);
      const current = await this.find(actor, input.templateId, trx, true);
      this.assertManager(current, user);
      if (
        new Date(current.updatedAt).getTime() !==
        new Date(previous.updatedAt).getTime()
      ) {
        throw new ConflictException('Template changed; reload before saving');
      }
      if (content !== undefined)
        await this.pages.validateDocumentContent(content);
      await this.repo.updateTemplate(
        {
          title: input.title,
          description: input.description,
          icon: input.icon,
          lastUpdatedById: actor.id,
          ...(content === undefined ? {} : { content }),
        },
        input.templateId,
        actor.workspaceId,
        trx,
      );
      if (content !== undefined) {
        const keep = this.attachmentIds(content);
        let retire = trx
          .updateTable('attachments')
          .set({ deletedAt: new Date() })
          .where('templateId', '=', input.templateId)
          .where('workspaceId', '=', actor.workspaceId);
        if (keep.length) retire = retire.where('id', 'not in', keep);
        await retire.execute();
      }
      return this.view(await this.find(actor, input.templateId, trx), user);
    };
    if (input.content === undefined)
      return this.db.transaction().execute((trx) => persist(trx));
    await this.pages.validateDocumentContent(input.content);
    const plan = await this.files.prepare(
      input.content,
      { templateId: input.templateId },
      { templateId: input.templateId },
      actor,
    );
    return this.files.execute(plan, persist, async (trx) => {
      const user = await this.requireActor(actor, trx);
      this.assertManager(
        await this.find(actor, input.templateId, trx, true),
        user,
      );
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const user = await this.requireActor(actor, trx);
      this.assertManager(await this.find(actor, id, trx, true), user);
      await this.repo.updateTemplate(
        { deletedAt: new Date() },
        id,
        actor.workspaceId,
        trx,
      );
      await trx
        .updateTable('attachments')
        .set({ deletedAt: new Date() })
        .where('templateId', '=', id)
        .where('workspaceId', '=', actor.workspaceId)
        .execute();
    });
    await this.audit.log({
      event: AuditEvent.TEMPLATE_DELETED,
      resourceType: AuditResource.TEMPLATE,
      resourceId: id,
    });
  }

  async use(actor: Actor, input: UseTemplate) {
    const template = await this.info(actor, input.templateId);
    const pageId = uuid7();
    const plan = await this.files.prepare(
      template.content,
      { templateId: template.id },
      {
        pageId,
        spaceId: input.spaceId,
      },
      actor,
    );
    let page: any;
    return this.files.execute(
      plan,
      async (trx) => {
        await this.requireActor(actor, trx);
        await this.assertDestination(actor, input, trx);
        await this.find(actor, template.id, trx, true);
        return page;
      },
      async (trx) => {
        await this.requireActor(actor, trx);
        await this.assertDestination(actor, input, trx);
        const current = await this.find(actor, template.id, trx, true);
        if (
          new Date(current.updatedAt).getTime() !==
          new Date(template.updatedAt).getTime()
        ) {
          throw new ConflictException('Template changed; select it again');
        }
        page = await this.pages.create(
          actor.id,
          actor.workspaceId,
          {
            title: template.title,
            icon: template.icon,
            content: plan.content,
            format: 'json',
            spaceId: input.spaceId,
            parentPageId: input.parentPageId,
          },
          trx,
          false,
          pageId,
        );
      },
    );
  }

  async file(actor: Actor, id: string) {
    await this.requireActor(actor);
    const attachment = await this.db
      .selectFrom('attachments')
      .innerJoin('templates', 'templates.id', 'attachments.templateId')
      .selectAll('attachments')
      .where('attachments.id', '=', id)
      .where('attachments.workspaceId', '=', actor.workspaceId)
      .where('templates.workspaceId', '=', actor.workspaceId)
      .where('templates.spaceId', 'is', null)
      .where('templates.deletedAt', 'is', null)
      .where('attachments.deletedAt', 'is', null)
      .where('attachments.type', '=', 'wikisavvy-template')
      .executeTakeFirst();
    if (!attachment) throw new NotFoundException('Template file not found');
    return attachment;
  }

  async prepareForPage(
    actor: Actor,
    input: { templateId: string; pageId: string },
  ) {
    const template = await this.info(actor, input.templateId);
    const page = await this.pageRepo.findById(input.pageId);
    if (!page || page.workspaceId !== actor.workspaceId || page.deletedAt)
      throw new NotFoundException('Page not found');
    const validate = async (trx: KyselyTransaction) => {
      await this.requireActor(actor, trx);
      await this.assertDestination(
        actor,
        {
          templateId: input.templateId,
          spaceId: page.spaceId,
          parentPageId: page.id,
        },
        trx,
      );
      const currentPage = await this.pageRepo.findById(page.id, { trx });
      if (currentPage.isLocked) throw new ForbiddenException('Page is locked');
      const current = await this.find(actor, template.id, trx, true);
      if (
        new Date(current.updatedAt).getTime() !==
        new Date(template.updatedAt).getTime()
      ) {
        throw new ConflictException('Template changed; select it again');
      }
    };
    await this.db.transaction().execute(validate);
    const plan = await this.files.prepare(
      template.content,
      { templateId: template.id },
      {
        pageId: page.id,
        spaceId: page.spaceId,
      },
      actor,
    );
    return this.files.execute(
      plan,
      async (trx, content) => {
        await validate(trx);
        return { title: template.title, content };
      },
      validate,
    );
  }

  private async requireActor(
    actor: Actor,
    db: KyselyDB | KyselyTransaction = this.db,
  ) {
    const user = await db
      .selectFrom('users')
      .select(['id', 'role'])
      .where('id', '=', actor.id)
      .where('workspaceId', '=', actor.workspaceId)
      .where('deletedAt', 'is', null)
      .where('deactivatedAt', 'is', null)
      .where('role', 'in', ['member', 'admin', 'owner'])
      .executeTakeFirst();
    if (!user) throw new ForbiddenException();
    return user;
  }

  private async find(
    actor: Actor,
    id: string,
    trx: KyselyTransaction,
    lock = false,
  ) {
    let query = trx
      .selectFrom('templates')
      .selectAll()
      .where('id', '=', id)
      .where('workspaceId', '=', actor.workspaceId)
      .where('spaceId', 'is', null)
      .where('deletedAt', 'is', null);
    if (lock) query = query.forUpdate();
    const template = await query.executeTakeFirst();
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  private assertManager(
    template: { creatorId: string },
    user: { id: string; role: string },
  ) {
    if (
      template.creatorId !== user.id &&
      !['admin', 'owner'].includes(user.role)
    ) {
      throw new ForbiddenException();
    }
  }

  private view(template: any, user: { id: string; role: string }): any {
    const {
      id,
      title,
      description,
      icon,
      content,
      workspaceId,
      spaceId,
      creatorId,
      createdAt,
      updatedAt,
    } = template;
    return {
      id,
      title,
      description,
      icon,
      content,
      workspaceId,
      spaceId,
      creatorId,
      createdAt,
      updatedAt,
      canManage:
        creatorId === user.id || ['admin', 'owner'].includes(user.role),
    };
  }

  private assertSourceUnchanged(
    initial: TemplateSourceSnapshot,
    current: TemplateSourceSnapshot,
  ) {
    const fingerprint = (source: TemplateSourceSnapshot) =>
      JSON.stringify([
        source.spaceId,
        source.title,
        source.icon,
        source.content,
      ]);
    if (fingerprint(initial) !== fingerprint(current)) {
      throw new ConflictException(
        'Source page changed; retry creating the snapshot',
      );
    }
  }

  private async assertDestination(
    actor: Actor,
    input: UseTemplate,
    trx: KyselyTransaction,
  ) {
    await this.pageRepo.lockPageHierarchySpaces([input.spaceId], trx);
    const space = await this.spaces.findById(input.spaceId, actor.workspaceId, {
      trx,
    });
    if (!space || space.deletedAt || space.archivedAt)
      throw new ForbiddenException('Destination is not writable');
    const roles = await this.members.getUserSpaceRoles(
      actor.id,
      input.spaceId,
      { trx, skipCache: true },
    );
    const role = findHighestUserSpaceRole(roles);
    if (input.parentPageId) {
      const parent = await this.pageRepo.findById(input.parentPageId, { trx });
      if (
        !parent ||
        parent.deletedAt ||
        parent.workspaceId !== actor.workspaceId ||
        parent.spaceId !== input.spaceId
      ) {
        throw new NotFoundException('Destination parent not found');
      }
      if (!['reader', 'writer', 'admin'].includes(role))
        throw new ForbiddenException();
      const access = await this.permissions.canUserEditPage(
        actor.id,
        parent.id,
        { trx, skipCache: true },
      );
      if (
        access.hasAnyRestriction
          ? !access.canAccess || !access.canEdit
          : !['writer', 'admin'].includes(role)
      ) {
        throw new ForbiddenException();
      }
    } else if (!['writer', 'admin'].includes(role)) {
      throw new ForbiddenException();
    }
  }

  private attachmentIds(content: any): string[] {
    const ids = new Set<string>();
    const walk = (node: any) => {
      if (node.attrs?.attachmentId) ids.add(node.attrs.attachmentId);
      for (const child of node.content ?? []) walk(child);
    };
    walk(content);
    return [...ids];
  }
}
