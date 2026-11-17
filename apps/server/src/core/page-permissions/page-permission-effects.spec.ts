import { WikisavvyPagePermissionEffects } from './page-permission-effects';

describe('Permission post-commit effects', () => {
  it('refreshes a content-free tree and rechecks live descendants without publishing grants', async () => {
    const collab = { recheckAccess: jest.fn(async () => {}) };
    const ws = {
      emitToSpace: jest.fn(),
      removeBaseSubscribersWithoutAccess: jest.fn(async () => {}),
    };
    const effects = new WikisavvyPagePermissionEffects(
      collab as any,
      ws as any,
    );
    await effects.afterChange('page', 'space');
    expect(collab.recheckAccess).toHaveBeenCalledWith({ pageIds: ['page'] });
    expect(ws.removeBaseSubscribersWithoutAccess).toHaveBeenCalledWith([
      'page',
    ]);
    expect(ws.emitToSpace).toHaveBeenCalledWith('space', {
      operation: 'refetchRootTreeNodeEvent',
      spaceId: 'space',
    });
  });
});
