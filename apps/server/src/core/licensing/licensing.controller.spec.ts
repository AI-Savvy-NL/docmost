import { LicensingController } from './licensing.controller';
import { UserRole } from '../../common/helpers/types/permission';

describe('WikiSavvy license owner boundary', () => {
  const workspace = { id: 'workspace' } as any;
  let service: any;
  let controller: LicensingController;
  beforeEach(() => {
    service = { status: jest.fn(), activate: jest.fn(), remove: jest.fn() };
    controller = new LicensingController(service);
  });
  it.each([UserRole.MEMBER, UserRole.ADMIN])(
    'rejects management by %s',
    async (role) => {
      const user = { id: 'user', workspaceId: 'workspace', role } as any;
      await expect(controller.status(user, workspace)).rejects.toThrow();
      await expect(
        controller.activate(user, workspace, { license: 'invalid' }),
      ).rejects.toThrow();
      await expect(controller.remove(user, workspace)).rejects.toThrow();
      expect(service.activate).not.toHaveBeenCalled();
    },
  );
  it('rejects an owner from a different workspace', async () => {
    await expect(
      controller.status(
        { workspaceId: 'other', role: UserRole.OWNER } as any,
        workspace,
      ),
    ).rejects.toThrow();
    expect(service.status).not.toHaveBeenCalled();
  });
  it('scopes owner writes to authenticated workspace context', async () => {
    await controller.activate(
      { id: 'owner', workspaceId: 'workspace', role: UserRole.OWNER } as any,
      workspace,
      { license: 'envelope' },
    );
    expect(service.activate).toHaveBeenCalledWith(
      'workspace',
      'owner',
      'envelope',
    );
  });
});
