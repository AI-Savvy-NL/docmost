import { WsService } from './ws.service';

function makeService(accessBySpace: Record<string, string[]>) {
  const spaceMemberRepo = {
    getUserIdsWithSpaceAccess: jest.fn(
      async (_userIds: string[], spaceId: string) =>
        new Set(accessBySpace[spaceId] ?? []),
    ),
  };
  const baseRealtime = {
    removeUsersFromSpaceBases: jest.fn(async () => undefined),
  };
  const socketsLeave = jest.fn();
  const server = { in: jest.fn(() => ({ socketsLeave })) };

  const service = new WsService(
    {} as any,
    {} as any,
    spaceMemberRepo as any,
    baseRealtime as any,
    {} as any,
    {} as any,
    {} as any,
  );
  service.setServer(server as any);

  return { service, server, socketsLeave, baseRealtime };
}

describe('WsService.removeUsersWithoutSpaceAccess', () => {
  it('removes users who lost access from the space room and its bases', async () => {
    const { service, server, socketsLeave, baseRealtime } = makeService({
      space_1: ['user_2'],
    });

    await service.removeUsersWithoutSpaceAccess(
      ['user_1', 'user_2'],
      ['space_1'],
    );

    expect(server.in).toHaveBeenCalledTimes(1);
    expect(server.in).toHaveBeenCalledWith(['user-user_1']);
    expect(socketsLeave).toHaveBeenCalledWith('space-space_1');
    expect(baseRealtime.removeUsersFromSpaceBases).toHaveBeenCalledWith(
      ['user_1'],
      'space_1',
    );
  });

  it('keeps users in spaces they can still access', async () => {
    const { service, server, socketsLeave, baseRealtime } = makeService({
      space_1: ['user_1'],
    });

    await service.removeUsersWithoutSpaceAccess(
      ['user_1'],
      ['space_1', 'space_2'],
    );

    expect(server.in).toHaveBeenCalledTimes(1);
    expect(socketsLeave).toHaveBeenCalledWith('space-space_2');
    expect(baseRealtime.removeUsersFromSpaceBases).toHaveBeenCalledTimes(1);
    expect(baseRealtime.removeUsersFromSpaceBases).toHaveBeenCalledWith(
      ['user_1'],
      'space_2',
    );
  });
});

describe('WsService fresh page-event recipients', () => {
  function fixture() {
    const allowed = { id: 'allowed-socket', data: { userId: 'allowed' }, emit: jest.fn() };
    const revoked = { id: 'revoked-socket', data: { userId: 'revoked' }, emit: jest.fn() };
    const broadcast = jest.fn();
    const cache = { get: jest.fn(async () => false), del: jest.fn() };
    const permissions = {
      hasRestrictedPagesInSpace: jest.fn(async () => true),
      hasRestrictedAncestor: jest.fn(async () => true),
      getUserIdsWithPageAccess: jest.fn(async () => ['allowed']),
      canUserEditPage: jest.fn(async () => ({ hasAnyRestriction: true, canAccess: true, canEdit: true })),
    };
    const members = { getUserSpaceRoles: jest.fn(async () => [{ role: 'writer' }]) };
    const service = new WsService(
      permissions as any, cache as any, members as any, {} as any,
      { findById: async () => ({ id: 'publisher', workspaceId: 'workspace' }) } as any,
      {} as any,
      { findById: async () => ({ id: 'page', workspaceId: 'workspace', spaceId: 'space' }) } as any,
    );
    service.setServer({
      in: () => ({ fetchSockets: async () => [allowed, revoked] }),
      to: () => ({ emit: broadcast }),
    } as any);
    const client = {
      id: 'publisher-socket', data: { userId: 'publisher', workspaceId: 'workspace' },
      rooms: new Set(['space-space']), broadcast: { to: () => ({ emit: broadcast }) },
    };
    return { service, allowed, revoked, broadcast, cache, permissions, client };
  }

  it.each(['tree', 'comment'])('does not trust a cached unrestricted-space shortcut for %s events', async (kind) => {
    const f = fixture();
    const data = { operation: 'updateOne', id: 'page', spaceId: 'space', title: 'private' };
    if (kind === 'tree') await f.service.handleTreeEvent(f.client as any, data);
    else await f.service.emitCommentEvent('space', 'page', data);
    expect(f.allowed.emit).toHaveBeenCalledWith('message', data);
    expect(f.revoked.emit).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.cache.get).not.toHaveBeenCalled();
  });

  it('does not broadcast page content when the recipient database check fails', async () => {
    const f = fixture();
    f.permissions.getUserIdsWithPageAccess.mockRejectedValue(new Error('database unavailable'));
    await expect(f.service.emitCommentEvent('space', 'page', { title: 'private' })).rejects.toThrow();
    expect(f.allowed.emit).not.toHaveBeenCalled();
    expect(f.revoked.emit).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
  });

  it('does not publish tree changes when the sender has lost page access', async () => {
    const f = fixture();
    f.permissions.canUserEditPage.mockResolvedValue({ hasAnyRestriction: true, canAccess: false, canEdit: false });
    await f.service.handleTreeEvent(f.client as any, { operation: 'updateOne', id: 'page', spaceId: 'space' });
    expect(f.allowed.emit).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
  });
});
