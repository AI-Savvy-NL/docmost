import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Server, Socket } from 'socket.io';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { JwtPayload } from '../core/auth/dto/jwt-payload';
import { isUserDisabled } from '../common/helpers';
import { SpaceRole } from '../common/helpers/types/permission';
import {
  TREE_EVENTS,
  WS_SPACE_RESTRICTION_CACHE_PREFIX,
  getSessionRoomName,
  getSpaceRoomName,
  getUserRoomName,
} from './ws.utils';
import { BaseRealtimeBridge } from './base-realtime.bridge';

@Injectable()
export class WsService {
  private readonly logger = new Logger(WsService.name);
  private server: Server;

  constructor(
    private readonly pagePermissionRepo: PagePermissionRepo,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly baseRealtime: BaseRealtimeBridge,
    private readonly userRepo: UserRepo,
    private readonly userSessionRepo: UserSessionRepo,
    private readonly pageRepo: PageRepo,
  ) {}

  setServer(server: Server): void {
    this.server = server;
  }

  async authorizeConnection(token: JwtPayload): Promise<string[]> {
    const [user, session, spaceIds] = await Promise.all([
      this.userRepo.findById(token.sub, token.workspaceId),
      token.sessionId
        ? this.userSessionRepo.findActiveById(token.sessionId)
        : undefined,
      this.spaceMemberRepo.getUserSpaceIds(token.sub),
    ]);

    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException();
    }

    if (
      token.sessionId &&
      (!session ||
        session.userId !== token.sub ||
        session.workspaceId !== token.workspaceId)
    ) {
      throw new UnauthorizedException();
    }

    return spaceIds;
  }

  async handleTreeEvent(client: Socket, data: any): Promise<void> {
    const room = getSpaceRoomName(data.spaceId);

    if (!client.rooms.has(room)) {
      return;
    }

    const userSpaceRoles = await this.spaceMemberRepo.getUserSpaceRoles(
      client.data.userId,
      data.spaceId,
    );
    const user = await this.userRepo.findById(client.data.userId, client.data.workspaceId);
    if (!user || isUserDisabled(user) || !userSpaceRoles?.length) {
      return;
    }

    if (data.operation === 'refetchRootTreeNodeEvent') {
      if (!userSpaceRoles.some(({ role }) => role === SpaceRole.ADMIN || role === SpaceRole.WRITER)) return;
      // Refresh is content-free; never relay arbitrary client fields to the room.
      client.broadcast.to(room).emit('message', {
        operation: 'refetchRootTreeNodeEvent', spaceId: data.spaceId,
      });
      return;
    }

    const pageId = this.extractPageId(data);
    if (!pageId) {
      return;
    }

    const page = await this.pageRepo.findById(pageId);
    if (!page || page.spaceId !== data.spaceId || page.workspaceId !== user.workspaceId) return;
    const access = await this.pagePermissionRepo.canUserEditPage(user.id, pageId);
    const canPublish = access.hasAnyRestriction ? access.canAccess && access.canEdit :
      userSpaceRoles.some(({ role }) => role === SpaceRole.ADMIN || role === SpaceRole.WRITER);
    if (!canPublish) return;

    await this.broadcastToAuthorizedUsers(room, client.id, pageId, data);
  }

  async invalidateSpaceRestrictionCache(spaceId: string): Promise<void> {
    try {
      await this.cacheManager.del(
        `${WS_SPACE_RESTRICTION_CACHE_PREFIX}${spaceId}`,
      );
    } catch (err) {
      this.logger.error(
        { err },
        `Failed to invalidate space restriction cache for ${spaceId}`,
      );
    }
  }

  async emitCommentEvent(
    spaceId: string,
    pageId: string,
    data: any,
  ): Promise<void> {
    const room = getSpaceRoomName(spaceId);

    await this.broadcastToAuthorizedUsers(room, null, pageId, data);
  }

  async emitToUsers(userIds: string[], data: any, pageId?: string): Promise<void> {
    if (userIds.length === 0) return;
    const recipients = pageId ? await this.pagePermissionRepo.getUserIdsWithPageAccess(pageId, userIds) : userIds;
    if (!recipients.length) return;
    const rooms = recipients.map((id) => getUserRoomName(id));
    this.server.to(rooms).emit('message', data);
  }

  disconnectUser(userId: string): void {
    this.server.in(getUserRoomName(userId)).disconnectSockets(true);
  }

  disconnectSession(sessionId: string): void {
    this.server.in(getSessionRoomName(sessionId)).disconnectSockets(true);
  }

  disconnectOtherSessions(userId: string, currentSessionId: string): void {
    this.server
      .in(getUserRoomName(userId))
      .except(getSessionRoomName(currentSessionId))
      .disconnectSockets(true);
  }

  async removeUsersWithoutSpaceAccess(
    userIds: string[],
    spaceIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;

    for (const spaceId of spaceIds) {
      try {
        const usersWithAccess =
          await this.spaceMemberRepo.getUserIdsWithSpaceAccess(
            userIds,
            spaceId,
          );
        const revokedUserIds = userIds.filter(
          (id) => !usersWithAccess.has(id),
        );
        if (revokedUserIds.length === 0) continue;

        this.server
          .in(revokedUserIds.map((id) => getUserRoomName(id)))
          .socketsLeave(getSpaceRoomName(spaceId));
        await this.baseRealtime.removeUsersFromSpaceBases(
          revokedUserIds,
          spaceId,
        );
      } catch (err) {
        this.logger.error(
          { err },
          `Failed to remove revoked users from space ${spaceId} rooms`,
        );
      }
    }
  }

  async removeBaseSubscribersWithoutAccess(pageIds: string[]): Promise<void> {
    try {
      await this.baseRealtime.removeSubscribersWithoutAccess(pageIds);
    } catch (err) {
      this.logger.error({ err }, 'Failed to remove base subscribers');
    }
  }

  emitToSpace(spaceId: string, data: any): void {
    this.server.to(getSpaceRoomName(spaceId)).emit('message', data);
  }

  async emitToSpaceExceptUsers(
    spaceId: string,
    excludeUserIds: string[],
    data: any,
  ): Promise<void> {
    this.server
      .to(getSpaceRoomName(spaceId))
      .except(excludeUserIds.map((id) => getUserRoomName(id)))
      .emit('message', data);
  }

  isTreeEvent(data: any): boolean {
    return TREE_EVENTS.has(data?.operation) && !!data?.spaceId;
  }

  private async broadcastToAuthorizedUsers(
    room: string,
    excludeSocketId: string | null,
    pageId: string,
    data: any,
  ): Promise<void> {
    const sockets = await this.server.in(room).fetchSockets();

    // Exclude only the originating socket, not every socket of the originating
    // user. Excluding by userId silently dropped the originator's other tabs
    // from receiving restricted-space tree events.
    const otherSockets = excludeSocketId
      ? sockets.filter((s) => s.id !== excludeSocketId)
      : sockets;
    if (otherSockets.length === 0) return;

    const userSocketMap = new Map<string, typeof otherSockets>();
    for (const socket of otherSockets) {
      const userId = socket.data.userId as string;
      if (!userId) continue;
      const existing = userSocketMap.get(userId);
      if (existing) {
        existing.push(socket);
      } else {
        userSocketMap.set(userId, [socket]);
      }
    }

    const candidateUserIds = Array.from(userSocketMap.keys());
    if (candidateUserIds.length === 0) return;

    const authorizedUserIds =
      await this.pagePermissionRepo.getUserIdsWithPageAccess(
        pageId,
        candidateUserIds,
      );

    const authorizedSet = new Set(authorizedUserIds);
    for (const [userId, userSockets] of userSocketMap) {
      if (authorizedSet.has(userId)) {
        for (const socket of userSockets) {
          socket.emit('message', data);
        }
      }
    }
  }

  private extractPageId(data: any): string | null {
    switch (data.operation) {
      case 'addTreeNode':
        return data.payload?.data?.id ?? null;
      case 'moveTreeNode':
        return data.payload?.id ?? null;
      case 'deleteTreeNode':
        return data.payload?.node?.id ?? null;
      case 'updateOne':
        return data.id ?? null;
      default:
        return null;
    }
  }
}
