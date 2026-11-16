import { WorkspaceService } from './workspace.service';
import { UserRole } from '../../../common/helpers/types/permission';
import { ForbiddenException } from '@nestjs/common';

const workspaceId = 'workspace-1';
const userId = 'user-1';
const authUser = { id: 'admin-1', role: UserRole.ADMIN } as any;

function buildService() {
  const trx = {
    deleteFrom: jest.fn(() => ({
      where: jest.fn(() => ({ execute: jest.fn() })),
    })),
  };
  const db = {
    transaction: () => ({ execute: (cb: (t: any) => any) => cb(trx) }),
  };
  const workspaceRepo = {
    findById: jest.fn().mockResolvedValue({ id: workspaceId }),
  };
  const userRepo = {
    findById: jest.fn().mockResolvedValue({
      id: userId,
      role: UserRole.MEMBER,
      deactivatedAt: null,
      deletedAt: null,
    }),
    updateUser: jest.fn(),
  };
  const repoDeletingByUser = () => ({
    deleteByUserAndWorkspace: jest.fn(),
  });
  const userSessionRepo = { revokeByUserId: jest.fn() };
  const integrationConnectionRepo = { deleteUserConnections: jest.fn() };
  const licensing = { lockWorkspace: jest.fn(), assertSeatAvailable: jest.fn() };

  const service = new WorkspaceService(
    workspaceRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    userRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    repoDeletingByUser() as any,
    repoDeletingByUser() as any,
    db as any,
    { add: jest.fn() } as any,
    {} as any,
    {} as any,
    { log: jest.fn() } as any,
    userSessionRepo as any,
    integrationConnectionRepo as any,
    { disconnectUser: jest.fn() } as any,
    { recheckAccess: jest.fn() } as any,
    licensing as any,
  );

  return { service, trx, integrationConnectionRepo, userRepo, licensing };
}

describe('WorkspaceService user offboarding', () => {
  it('deletes personal integration connections on deactivation', async () => {
    const { service, trx, integrationConnectionRepo } = buildService();

    await service.deactivateUser(authUser, userId, workspaceId);

    expect(integrationConnectionRepo.deleteUserConnections).toHaveBeenCalledWith(
      userId,
      trx,
    );
  });

  it('deletes personal integration connections on deletion', async () => {
    const { service, trx, integrationConnectionRepo } = buildService();

    await service.deleteUser(authUser, userId, workspaceId);

    expect(integrationConnectionRepo.deleteUserConnections).toHaveBeenCalledWith(
      userId,
      trx,
    );
  });
});

describe('WorkspaceService licensed reactivation', () => {
  it('does not reactivate a member when there is no seat', async () => {
    const { service, userRepo, licensing } = buildService();
    userRepo.findById.mockResolvedValue({
      id: userId, role: UserRole.MEMBER, deactivatedAt: new Date(), deletedAt: null,
    });
    licensing.assertSeatAvailable.mockRejectedValue(new ForbiddenException('Licensed seat limit reached'));
    await expect(service.activateUser(authUser, userId, workspaceId)).rejects.toThrow('seat limit');
    expect(userRepo.updateUser).not.toHaveBeenCalled();
  });

  it('checks capacity and updates membership in the same transaction', async () => {
    const { service, userRepo, licensing, trx } = buildService();
    userRepo.findById.mockResolvedValue({
      id: userId, role: UserRole.MEMBER, deactivatedAt: new Date(), deletedAt: null,
    });
    await service.activateUser(authUser, userId, workspaceId);
    expect(licensing.assertSeatAvailable).toHaveBeenCalledWith(workspaceId, trx);
    expect(userRepo.updateUser).toHaveBeenCalledWith({ deactivatedAt: null }, userId, workspaceId, trx);
  });
});
