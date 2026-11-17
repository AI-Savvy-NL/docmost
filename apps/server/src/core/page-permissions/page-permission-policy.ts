import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PageRepo } from '../../database/repos/page/page.repo';
import { PagePermissionRepo } from '../../database/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '../../database/repos/space/space-member.repo';
import { SpaceRepo } from '../../database/repos/space/space.repo';
import { UserRepo } from '../../database/repos/user/user.repo';
import { findHighestUserSpaceRole } from '../../database/repos/space/utils';
import type { KyselyTransaction } from '../../database/types/kysely.types';
import type { User } from '../../database/types/entity.types';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { LicensingService } from '../licensing/licensing.service';

@Injectable()
export class WikisavvyPagePermissionPolicy {
  constructor(
    private readonly pages: PageRepo,
    private readonly users: UserRepo,
    private readonly spaceMembers: SpaceMemberRepo,
    private readonly permissions: PagePermissionRepo,
    private readonly licensing: LicensingService,
    private readonly spaces: SpaceRepo,
  ) {}

  async assertCanManage(
    actor: Pick<User, 'id' | 'workspaceId'>,
    workspaceId: string,
    pageId: string,
    trx: KyselyTransaction,
  ) {
    if (!trx?.isTransaction) {
      throw new Error('Page permission management requires a transaction');
    }
    if (!actor?.id || actor.workspaceId !== workspaceId) {
      throw new ForbiddenException();
    }
    const original = await this.pages.findById(pageId, { trx });
    if (!original || original.deletedAt || original.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }
    await this.pages.lockPageHierarchySpaces([original.spaceId], trx);
    const page = await this.pages.findById(pageId, { trx });
    if (!page || page.deletedAt || page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }
    if (page.spaceId !== original.spaceId) {
      throw new ConflictException('Page location changed; refresh and retry');
    }
    const space = await this.spaces.findById(page.spaceId, workspaceId, { trx });
    if (!space || space.deletedAt) {
      throw new NotFoundException('Page not found');
    }
    if (space.archivedAt) {
      throw new ForbiddenException('Archived spaces are read-only');
    }
    const user = await this.users.findById(actor.id, workspaceId, { trx });
    if (!user || isUserDisabled(user)) {
      throw new ForbiddenException();
    }
    const roles = await this.spaceMembers.getUserSpaceRoles(user.id, page.spaceId, {
      trx,
      skipCache: true,
    });
    const role = findHighestUserSpaceRole(roles);
    if (![SpaceRole.ADMIN, SpaceRole.WRITER, SpaceRole.READER].includes(role as SpaceRole)) {
      throw new ForbiddenException();
    }
    const access = await this.permissions.canUserEditPage(user.id, page.id, {
      trx,
      skipCache: true,
    });
    if (
      access.hasAnyRestriction
        ? !access.canAccess || !access.canEdit
        : role === SpaceRole.READER
    ) {
      throw new ForbiddenException();
    }
    return page;
  }

  async assertCanSetRestriction(
    actor: Pick<User, 'id' | 'workspaceId'>,
    workspaceId: string,
    pageId: string,
    trx: KyselyTransaction,
  ) {
    const page = await this.assertCanManage(actor, workspaceId, pageId, trx);
    const existing = await this.permissions.findPageAccessByPageId(page.id, trx);
    if (existing) return page;

    await this.licensing.lockWorkspace(workspaceId, trx);
    if (!await this.canCreateRestriction(workspaceId, trx)) {
      throw new ForbiddenException('A valid WikiSavvy license is required to restrict another page');
    }
    return page;
  }

  async canCreateRestriction(workspaceId: string, trx: KyselyTransaction): Promise<boolean> {
    try {
      const license = await this.licensing.status(workspaceId, trx);
      return ['valid', 'grace'].includes(license.status) &&
        license.features.includes('wikisavvy.page-permissions');
    } catch {
      return false;
    }
  }
}
