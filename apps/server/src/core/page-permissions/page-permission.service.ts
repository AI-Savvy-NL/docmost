import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { User } from '../../database/types/entity.types';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import {
  AuditEvent,
  AuditResource,
  type AuditLogPayload,
} from '../../common/events/audit-events';
import { WikisavvyPagePermissionRepo } from './page-permission.repo';
import { WikisavvyPagePermissionPolicy } from './page-permission-policy';
import type { PermissionChange } from './page-permission.types';
import { WikisavvyPagePermissionEffects } from './page-permission-effects';

type Actor = Pick<User, 'id' | 'workspaceId'>;

@Injectable()
export class WikisavvyPagePermissionService {
  constructor(
    private readonly repository: WikisavvyPagePermissionRepo,
    private readonly policy: WikisavvyPagePermissionPolicy,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
    private readonly effects: WikisavvyPagePermissionEffects,
  ) {}

  info(actor: Actor, pageId: string) {
    return this.repository.transaction(async (trx) => {
      const page = await this.policy.assertCanManage(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      return this.repository.snapshot(page.id, trx);
    });
  }

  state(actor: Actor, pageId: string) {
    return this.repository.transaction(async (trx) => {
      const page = await this.policy.assertCanManage(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      const snapshot = await this.repository.snapshot(page.id, trx);
      const grants = await this.repository.describeGrants(
        snapshot.grants,
        page.workspaceId,
        trx,
      );
      return {
        ...snapshot,
        grants,
        canCreateRestriction:
          !snapshot.hasDirectRestriction &&
          (await this.policy.canCreateRestriction(actor.workspaceId, trx)),
      };
    });
  }

  principals(actor: Actor, pageId: string, query: string) {
    if (typeof query !== 'string' || query.length > 100)
      throw new BadRequestException('Invalid principal search');
    return this.repository.transaction(async (trx) => {
      const page = await this.policy.assertCanManage(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      return this.repository.principals(page, query.trim(), trx);
    });
  }

  private validateRevision(revision: string) {
    if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) {
      throw new BadRequestException('Invalid permission revision');
    }
  }

  private async record(payload: AuditLogPayload) {
    try {
      await this.audit.log(payload);
    } catch {
      return;
    }
  }

  private async notify(pageId: string, spaceId: string) {
    try {
      await this.effects.afterChange(pageId, spaceId);
    } catch {
      return;
    }
  }

  async set(actor: Actor, pageId: string, change: PermissionChange) {
    this.validateRevision(change?.revision);
    if (!Array.isArray(change.grants) || change.grants.length > 500)
      throw new BadRequestException('Invalid permission grants');
    const seen = new Set<string>();
    for (const grant of change.grants) {
      if (
        !grant ||
        !['user', 'group'].includes(grant.type) ||
        !isUUID(grant.id) ||
        !['reader', 'writer'].includes(grant.role)
      ) {
        throw new BadRequestException('Invalid permission principal or role');
      }
      const key = `${grant.type}:${grant.id.toLowerCase()}`;
      if (seen.has(key))
        throw new BadRequestException('Duplicate permission principal');
      seen.add(key);
    }
    const outcome = await this.repository.transaction(async (trx) => {
      await this.repository.lockWorkspace(actor.workspaceId, trx);
      let page = await this.policy.assertCanManage(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      await this.repository.lockPrincipals(page, trx);
      page = await this.policy.assertCanManage(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      const previous = await this.repository.snapshot(page.id, trx);
      if (previous.revision !== change.revision)
        throw new ConflictException('Permissions changed; refresh and retry');
      await this.policy.assertCanSetRestriction(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      await this.repository.validatePrincipals(change.grants, page, trx);
      await this.repository.replace(page, actor.id, change.grants, trx);
      await this.repository.assertSurvivingWriters(page, trx);
      return {
        previous,
        next: await this.repository.snapshot(page.id, trx),
        spaceId: page.spaceId,
      };
    });
    await this.notify(outcome.next.pageId, outcome.spaceId);
    const resource = {
      resourceType: AuditResource.PAGE,
      resourceId: pageId,
      spaceId: outcome.spaceId,
    };
    if (!outcome.previous.hasDirectRestriction) {
      await this.record({
        ...resource,
        event: AuditEvent.PAGE_RESTRICTED,
        metadata: { count: outcome.next.grants.length, hasRestriction: true },
      });
    }
    const key = (grant: (typeof outcome.next.grants)[number]) =>
      `${grant.type}:${grant.id}`;
    const previous = new Map(
      outcome.previous.grants.map((grant) => [key(grant), grant]),
    );
    const next = new Map(
      outcome.next.grants.map((grant) => [key(grant), grant]),
    );
    for (const grant of outcome.next.grants) {
      const old = previous.get(key(grant));
      if (old?.role === grant.role) continue;
      await this.record({
        ...resource,
        event: old
          ? AuditEvent.PAGE_PERMISSION_ROLE_CHANGED
          : AuditEvent.PAGE_PERMISSION_ADDED,
        metadata: {
          ...(grant.type === 'user'
            ? { userId: grant.id }
            : { groupId: grant.id }),
          role: grant.role,
        },
        ...(old
          ? {
              changes: {
                before: { role: old.role },
                after: { role: grant.role },
              },
            }
          : {}),
      });
    }
    for (const grant of outcome.previous.grants) {
      if (next.has(key(grant))) continue;
      await this.record({
        ...resource,
        event: AuditEvent.PAGE_PERMISSION_REMOVED,
        metadata: {
          ...(grant.type === 'user'
            ? { userId: grant.id }
            : { groupId: grant.id }),
          role: grant.role,
        },
      });
    }
    return outcome.next;
  }

  async remove(actor: Actor, pageId: string, revision: string) {
    this.validateRevision(revision);
    const outcome = await this.repository.transaction(async (trx) => {
      await this.repository.lockWorkspace(actor.workspaceId, trx);
      let page = await this.policy.assertCanManage(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      await this.repository.lockPrincipals(page, trx);
      page = await this.policy.assertCanManage(
        actor,
        actor.workspaceId,
        pageId,
        trx,
      );
      const previous = await this.repository.snapshot(page.id, trx);
      if (previous.revision !== revision)
        throw new ConflictException('Permissions changed; refresh and retry');
      if (!previous.hasDirectRestriction)
        throw new BadRequestException('No direct restriction to remove');
      await this.repository.remove(page.id, trx);
      await this.repository.assertSurvivingWriters(page, trx);
      return {
        next: await this.repository.snapshot(page.id, trx),
        spaceId: page.spaceId,
        previous,
      };
    });
    await this.notify(outcome.next.pageId, outcome.spaceId);
    await this.record({
      event: AuditEvent.PAGE_RESTRICTION_REMOVED,
      resourceType: AuditResource.PAGE,
      resourceId: pageId,
      spaceId: outcome.spaceId,
      metadata: {
        hasRestriction: Boolean(outcome.next.inheritedPageId),
        count: outcome.previous.grants.length,
      },
    });
    return outcome.next;
  }
}
