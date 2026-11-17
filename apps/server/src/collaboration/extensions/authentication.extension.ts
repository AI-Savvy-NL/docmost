import {
  Connection,
  Extension,
  Hocuspocus,
  onAuthenticatePayload,
  onConfigurePayload,
  onLoadDocumentPayload,
  beforeHandleMessagePayload,
} from '@hocuspocus/server';
import { Forbidden } from '@hocuspocus/common';
import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { TokenService } from '../../core/auth/services/token.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { findHighestUserSpaceRole } from '@docmost/db/repos/space/utils';
import { Page, User } from '@docmost/db/types/entity.types';
import { SpaceRole } from '../../common/helpers/types/permission';
import { isUserDisabled } from '../../common/helpers';
import { getPageId } from '../collaboration.util';
import { COLLAB_ACCESS_RECHECK_CHANNEL } from '../constants';
import { CollabAccessRecheck } from '../services/collab-access.service';
import { JwtCollabPayload, JwtType } from '../../core/auth/dto/jwt-payload';
import { InjectKysely } from 'nestjs-kysely';
import type { KyselyDB, KyselyTransaction } from '../../database/types/kysely.types';

import { CollabConnectionGuard, type CollabAccess } from './collab-connection-guard';

@Injectable()
export class AuthenticationExtension implements Extension {
  private readonly logger = new Logger(AuthenticationExtension.name);
  private instance: Hocuspocus;
  private subscriber: Redis;
  private readonly guards = new WeakMap<Connection, CollabConnectionGuard>();

  constructor(
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private pageRepo: PageRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    private readonly redisService: RedisService,
    private readonly spaceRepo: SpaceRepo,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async onLoadDocument({ document, documentName }: onLoadDocumentPayload) {
    const addConnection = document.addConnection.bind(document);
    // Registration precedes initial awareness; the connected hook is too late.
    document.addConnection = (connection) => {
      const guard = new CollabConnectionGuard(connection, () =>
        this.connectionAccess(connection, getPageId(documentName)),
      );
      this.guards.set(connection, guard);
      return addConnection(connection);
    };
  }

  async beforeHandleMessage({ connection }: beforeHandleMessagePayload) {
    const guard = this.guards.get(connection);
    if (!guard) {
      connection.close(Forbidden);
      throw Forbidden;
    }
    const access = await guard.authorize();
    // Outbound checks may restrict, but only this message's fresh check may enable writes.
    if (access === 'write') connection.readOnly = false;
  }

  async onConfigure({ instance }: onConfigurePayload) {
    this.instance = instance;
    this.subscriber = this.redisService.getOrThrow().duplicate();
    this.subscriber.on('error', () => {});
    this.subscriber.on('message', async (_channel, message) => {
      try {
        await this.recheckAccess(JSON.parse(message));
      } catch (err) {
        this.logger.error({ err }, 'Failed to recheck collab access');
      }
    });
    // resubscribe on every ready, ioredis never replays a SUBSCRIBE that failed while redis was down
    this.subscriber.on('ready', () => {
      this.subscriber
        .subscribe(COLLAB_ACCESS_RECHECK_CHANNEL)
        .catch((err) =>
          this.logger.error({ err }, 'Failed to subscribe to collab rechecks'),
        );
    });
  }

  async onDestroy() {
    this.subscriber?.disconnect();
  }

  async onAuthenticate(data: onAuthenticatePayload) {
    const { documentName, token } = data;
    const pageId = getPageId(documentName);

    let jwtPayload: JwtCollabPayload;

    try {
      jwtPayload = await this.tokenService.verifyJwt(token, JwtType.COLLAB);
    } catch (error) {
      throw new UnauthorizedException('Invalid collab token');
    }

    const userId = jwtPayload.sub;
    const workspaceId = jwtPayload.workspaceId;

    const { user, page, access } = await this.accessSnapshot(userId, workspaceId, pageId);

    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if (!page || page.workspaceId !== workspaceId) {
      this.logger.debug(`Page not found: ${pageId}`);
      throw new NotFoundException('Page not found');
    }

    if (access === 'none') {
      this.logger.warn(`User ${user.id} not authorized to access page: ${pageId}`);
      throw new UnauthorizedException();
    }

    if (access === 'read') {
      data.connectionConfig.readOnly = true;
    }

    this.logger.debug(`Authenticated user ${user.id} on page ${pageId}`);

    return {
      user,
    };
  }

  async recheckAccess({
    userIds = [],
    pageIds = [],
  }: CollabAccessRecheck): Promise<void> {
    if (!this.instance?.documents.size) return;

    const recheckUserIds = new Set(userIds);
    const recheckPageIds = new Set<string>();
    for (const pageId of pageIds) {
      const pages = await this.pageRepo.getPageAndDescendants(pageId, {
        includeContent: false,
      });
      pages.forEach((page) => recheckPageIds.add(page.id));
    }

    for (const document of this.instance.documents.values()) {
      const pageId = getPageId(document.name);
      const connections = document.getConnections().filter((connection) => {
        const userId = connection.context?.user?.id;
        return (
          userId && (recheckPageIds.has(pageId) || recheckUserIds.has(userId))
        );
      });
      if (connections.length === 0) continue;

      for (const connection of connections) {
        try {
          await this.recheckConnection(connection, pageId);
        } catch {
          connection.close(Forbidden);
          this.logger.warn('Collaboration authorization failed; connection closed');
        }
      }
    }
  }

  private async recheckConnection(
    connection: Connection,
    pageId: string,
  ): Promise<void> {
    const guard = this.guards.get(connection);
    if (guard) {
      await guard.authorize();
      return;
    }
    const access = await this.connectionAccess(connection, pageId);
    if (access === 'write' || (access === 'read' && connection.readOnly)) {
      return;
    }
    connection.readOnly = true;
    connection.sendStateless(JSON.stringify({ type: 'page.permissions', access }));
    if (access === 'none') connection.close(Forbidden);
  }

  private async connectionAccess(connection: Connection, pageId: string): Promise<CollabAccess> {
    const { id, workspaceId } = connection.context?.user ?? {};
    if (!id || !workspaceId) return 'none';
    return (await this.accessSnapshot(id, workspaceId, pageId)).access;
  }

  private accessSnapshot(id: string, workspaceId: string, pageId: string) {
    return this.db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
      const [user, page] = await Promise.all([
        this.userRepo.findById(id, workspaceId, { trx }),
        this.pageRepo.findById(pageId, { trx }),
      ]);
      let access: CollabAccess = 'none';
      if (user && !isUserDisabled(user) && page?.workspaceId === workspaceId) {
        access = await this.getAccess(user, page, trx);
      }
      return { user, page, access };
    });
  }

  // a connection outlives this check, so it must not see a stale cached allow
  private async getAccess(user: User, page: Page, trx: KyselyTransaction): Promise<CollabAccess> {
    const [space, spaceRoles, { hasAnyRestriction, canAccess, canEdit }] =
      await Promise.all([
        this.spaceRepo.findById(page.spaceId, user.workspaceId, { trx }),
        this.spaceMemberRepo.getUserSpaceRoles(user.id, page.spaceId, {
          skipCache: true,
          trx,
        }),
        this.pagePermissionRepo.canUserEditPage(user.id, page.id, {
          skipCache: true,
          trx,
        }),
      ]);

    const userSpaceRole = findHighestUserSpaceRole(spaceRoles);
    if (!space || space.deletedAt || !userSpaceRole) return 'none';
    if (hasAnyRestriction && !canAccess) return 'none';

    const canWrite = hasAnyRestriction
      ? canEdit
      : userSpaceRole !== SpaceRole.READER;
    return canWrite && !page.deletedAt && !space.archivedAt ? 'write' : 'read';
  }
}
