import { AuthService } from './auth.service';
import { comparePasswordHash } from '../../../common/helpers';
import { AuditEvent } from '../../../common/events/audit-events';

jest.mock('../../../common/helpers', () => ({
  ...jest.requireActual('../../../common/helpers'),
  comparePasswordHash: jest.fn(),
}));

describe('Successful login audit identity', () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  function setup() {
    const userRepo = {
      findByEmail: jest.fn().mockResolvedValue({
        id: userId, workspaceId, email: 'test@example.invalid',
        password: 'synthetic-hash', deletedAt: null, deactivatedAt: null,
      }),
      updateLastLogin: jest.fn(),
    };
    const audit = { setActorId: jest.fn(), log: jest.fn() };
    const sessions = { createSessionAndToken: jest.fn().mockResolvedValue('synthetic-session') };
    const service = new AuthService(
      {} as any, {} as any, sessions as any, {} as any, userRepo as any,
      {} as any, {} as any, {} as any,
      { isCloud: () => false, getAppSecret: () => 'x'.repeat(32) } as any,
      {} as any, {} as any, audit as any, {} as any,
    );
    return { service, audit, sessions };
  }
  beforeEach(() => jest.mocked(comparePasswordHash).mockResolvedValue(true));
  afterEach(() => jest.clearAllMocks());
  it('sets the authenticated actor before recording the login', async () => {
    const { service, audit } = setup();
    await service.login({ email: 'test@example.invalid', password: 'synthetic-input' }, workspaceId);
    expect(audit.setActorId).toHaveBeenCalledWith(userId);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ event: AuditEvent.USER_LOGIN }));
    expect(audit.setActorId.mock.invocationCallOrder[0]).toBeLessThan(audit.log.mock.invocationCallOrder[0]);
  });
  it('does not assign an authenticated actor to failed credentials', async () => {
    jest.mocked(comparePasswordHash).mockResolvedValue(false);
    const { service, audit, sessions } = setup();
    await expect(service.login({ email: 'test@example.invalid', password: 'synthetic-input' }, workspaceId)).rejects.toThrow();
    expect(audit.setActorId).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(sessions.createSessionAndToken).not.toHaveBeenCalled();
  });
});
