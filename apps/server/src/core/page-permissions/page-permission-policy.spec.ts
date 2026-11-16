import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WikisavvyPagePermissionPolicy } from './page-permission-policy';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const pageId = '33333333-3333-4333-8333-333333333333';
const spaceId = '44444444-4444-4444-8444-444444444444';
const actor = { id: userId, workspaceId };
const trx = { isTransaction: true } as any;

function setup() {
  const page = { id: pageId, spaceId, workspaceId, deletedAt: null } as any;
  const pages = {
    findById: jest.fn().mockImplementation(async () => ({ ...page })),
    lockPageHierarchySpaces: jest.fn().mockResolvedValue(undefined),
  };
  const users = {
    findById: jest.fn().mockResolvedValue({ ...actor, role: 'member', deletedAt: null, deactivatedAt: null }),
  };
  const spaces = { getUserSpaceRoles: jest.fn().mockResolvedValue([{ userId, role: 'writer' }]) };
  const spaceRepo = {
    findById: jest.fn().mockResolvedValue({ id: spaceId, workspaceId, deletedAt: null, archivedAt: null }),
  };
  const permissions = {
    canUserEditPage: jest.fn().mockResolvedValue({ hasAnyRestriction: false, canAccess: true, canEdit: true }),
    findPageAccessByPageId: jest.fn().mockResolvedValue(undefined),
  };
  const licensing = {
    lockWorkspace: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue({
      status: 'valid', features: ['wikisavvy.page-permissions'],
    }),
  };
  const policy = new WikisavvyPagePermissionPolicy(
    pages as any, users as any, spaces as any, permissions as any, licensing as any, spaceRepo as any,
  );
  return { policy, page, pages, users, spaces, spaceRepo, permissions, licensing };
}

describe('Independent page permission management policy', () => {
  it('locks location before re-reading and authorizing on the transaction', async () => {
    const { policy, pages, users, spaces, permissions } = setup();
    await policy.assertCanManage(actor, workspaceId, pageId, trx);
    expect(pages.findById).toHaveBeenNthCalledWith(1, pageId, { trx });
    expect(pages.findById).toHaveBeenNthCalledWith(2, pageId, { trx });
    expect(pages.lockPageHierarchySpaces).toHaveBeenCalledWith([spaceId], trx);
    expect(pages.findById.mock.invocationCallOrder[0]).toBeLessThan(pages.lockPageHierarchySpaces.mock.invocationCallOrder[0]);
    expect(pages.lockPageHierarchySpaces.mock.invocationCallOrder[0]).toBeLessThan(pages.findById.mock.invocationCallOrder[1]);
    expect(pages.findById.mock.invocationCallOrder[1]).toBeLessThan(users.findById.mock.invocationCallOrder[0]);
    expect(users.findById).toHaveBeenCalledWith(userId, workspaceId, { trx });
    expect(spaces.getUserSpaceRoles).toHaveBeenCalledWith(userId, spaceId, { trx, skipCache: true });
    expect(permissions.canUserEditPage).toHaveBeenCalledWith(userId, pageId, { trx, skipCache: true });
  });
  it.each(['member', 'admin', 'owner'])('allows an effective writer without requiring workspace %s privileges', async (role) => {
    const { policy, users } = setup();
    users.findById.mockResolvedValue({ ...actor, role });
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).resolves.toMatchObject({ id: pageId });
  });
  it.each(['admin', 'owner'])('does not grant workspace %s a space-membership bypass', async (role) => {
    const { policy, users, spaces } = setup();
    users.findById.mockResolvedValue({ ...actor, role });
    spaces.getUserSpaceRoles.mockResolvedValue(undefined);
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
  });
  it('denies an unrestricted space reader', async () => {
    const { policy, spaces } = setup();
    spaces.getUserSpaceRoles.mockResolvedValue([{ userId, role: 'reader' }]);
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
  });
  it('allows a space reader who has effective restricted-page writer access', async () => {
    const { policy, spaces, permissions } = setup();
    spaces.getUserSpaceRoles.mockResolvedValue([{ userId, role: 'reader' }]);
    permissions.canUserEditPage.mockResolvedValue({ hasAnyRestriction: true, canAccess: true, canEdit: true });
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).resolves.toMatchObject({ id: pageId });
  });
  it.each([
    { hasAnyRestriction: true, canAccess: false, canEdit: true },
    { hasAnyRestriction: true, canAccess: true, canEdit: false },
  ])('requires both ancestor traversal and effective restricted writer access', async (access) => {
    const { policy, permissions } = setup();
    permissions.canUserEditPage.mockResolvedValue(access);
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
  });
  it('rejects foreign authenticated workspace context before looking up a page', async () => {
    const { policy, pages } = setup();
    await expect(policy.assertCanManage({ ...actor, workspaceId: spaceId }, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
    expect(pages.findById).not.toHaveBeenCalled();
  });
  it.each([{ workspaceId: spaceId }, { deletedAt: new Date() }])('does not disclose foreign or deleted pages', async (change) => {
    const { policy, pages, page } = setup();
    pages.findById.mockResolvedValue({ ...page, ...change });
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(NotFoundException);
    expect(pages.lockPageHierarchySpaces).not.toHaveBeenCalled();
  });
  it('rejects a page that moves to another space while waiting for its lock', async () => {
    const { policy, pages, page, permissions } = setup();
    pages.findById.mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, spaceId: userId });
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(ConflictException);
    expect(permissions.canUserEditPage).not.toHaveBeenCalled();
  });
  it.each([undefined, { deletedAt: new Date() }])('does not authorize a missing or deleted space', async (space) => {
    const { policy, spaceRepo } = setup();
    spaceRepo.findById.mockResolvedValue(space);
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(NotFoundException);
    expect(spaceRepo.findById).toHaveBeenCalledWith(spaceId, workspaceId, { trx });
  });
  it('does not authorize writes in an archived space', async () => {
    const { policy, spaceRepo } = setup();
    spaceRepo.findById.mockResolvedValue({ id: spaceId, workspaceId, archivedAt: new Date() });
    await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
  });
  it.each([undefined, { ...actor, deactivatedAt: new Date() }, { ...actor, deletedAt: new Date() }])(
    'rejects a missing or disabled account from the fresh transaction lookup',
    async (user) => {
      const { policy, users } = setup();
      users.findById.mockResolvedValue(user);
      await expect(policy.assertCanManage(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
    },
  );
  it('refuses a non-transactional caller', async () => {
    const { policy, pages } = setup();
    await expect(policy.assertCanManage(actor, workspaceId, pageId, { isTransaction: false } as any)).rejects.toThrow('transaction');
    expect(pages.findById).not.toHaveBeenCalled();
  });
  it.each(['valid', 'grace'])('allows new direct restrictions only with an effective %s capability', async (status) => {
    const { policy, licensing, permissions } = setup();
    licensing.status.mockResolvedValue({ status, features: ['wikisavvy.page-permissions'] });
    await policy.assertCanSetRestriction(actor, workspaceId, pageId, trx);
    expect(permissions.findPageAccessByPageId).toHaveBeenCalledWith(pageId, trx);
    expect(licensing.lockWorkspace).toHaveBeenCalledWith(workspaceId, trx);
    expect(licensing.status).toHaveBeenCalledWith(workspaceId, trx);
  });
  it.each(['community', 'expired', 'invalid', 'not-yet-valid'])('denies creation for license state %s', async (status) => {
    const { policy, licensing } = setup();
    licensing.status.mockResolvedValue({ status, features: ['wikisavvy.page-permissions'] });
    await expect(policy.assertCanSetRestriction(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
  });
  it('does not treat raw signed capabilities as implemented entitlement', async () => {
    const { policy, licensing } = setup();
    licensing.status.mockResolvedValue({ status: 'valid', features: [], license: { capabilities: ['wikisavvy.page-permissions'] } } as any);
    await expect(policy.assertCanSetRestriction(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
  });
  it('allows maintenance of a direct restriction without consulting licensing', async () => {
    const { policy, permissions, licensing } = setup();
    permissions.findPageAccessByPageId.mockResolvedValue({ id: spaceId, pageId, accessLevel: 'restricted' });
    licensing.status.mockRejectedValue(new Error('license store unavailable'));
    await expect(policy.assertCanSetRestriction(actor, workspaceId, pageId, trx)).resolves.toMatchObject({ id: pageId });
    expect(licensing.lockWorkspace).not.toHaveBeenCalled();
    expect(licensing.status).not.toHaveBeenCalled();
  });
  it('requires a license to add a direct restriction even when an ancestor already restricts access', async () => {
    const { policy, permissions, licensing } = setup();
    permissions.canUserEditPage.mockResolvedValue({ hasAnyRestriction: true, canAccess: true, canEdit: true });
    licensing.status.mockResolvedValue({ status: 'expired', features: [] });
    await expect(policy.assertCanSetRestriction(actor, workspaceId, pageId, trx)).rejects.toThrow(ForbiddenException);
  });
});
