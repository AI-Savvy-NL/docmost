import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';
import { BadRequestException } from '@nestjs/common';

jest.mock('../../../common/helpers', () => ({
  ...jest.requireActual('../../../common/helpers'),
  hashPassword: jest.fn(async () => 'synthetic-password-hash'),
}));

function fixture(policy: { enforceSso: boolean; enforceMfa: boolean }) {
  const workspace = { id: randomUUID(), ...policy };
  const user = {
    id: randomUUID(),
    workspaceId: workspace.id,
    email: 'recovery@example.invalid',
    name: 'Recovery fixture',
    emailVerifiedAt: new Date(),
    deletedAt: null,
    deactivatedAt: null,
  };
  const token = {
    id: randomUUID(),
    userId: user.id,
    workspaceId: workspace.id,
    type: 'forgot-password',
    usedAt: null,
    expiresAt: new Date(Date.now() + 60000),
  };
  const query = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    forNoKeyUpdate: jest.fn().mockReturnThis(),
    execute: jest.fn(),
    executeTakeFirst: jest.fn(async () => ({ id: user.id })),
  };
  const trx = {
    selectFrom: jest.fn(() => query),
    deleteFrom: jest.fn(() => query),
  };
  const sessions = {
    createSessionAndToken: jest.fn(async () => 'synthetic-session'),
  };
  const sessionRepo = { deleteByUserId: jest.fn() };
  const userRepo = {
    findById: jest.fn(async () => user),
    updateUser: jest.fn(),
  };
  const tokens = {
    findById: jest.fn(async () => token),
    consumePasswordResetToken: jest.fn(async () => token),
  };
  const service = new AuthService(
    {} as any,
    {} as any,
    sessions as any,
    sessionRepo as any,
    userRepo as any,
    tokens as any,
    { sendToQueue: jest.fn() } as any,
    {} as any,
    { isCloud: () => false } as any,
    { emitAsync: jest.fn() } as any,
    {
      transaction: () => ({ execute: (callback: any) => callback(trx) }),
    } as any,
    { setActorId: jest.fn(), log: jest.fn() } as any,
    { disconnectUser: jest.fn() } as any,
  );
  return { service, workspace, sessions, token };
}

describe('Password recovery requires normal sign-in', () => {
  it.each([
    { enforceSso: false, enforceMfa: false },
    { enforceSso: true, enforceMfa: false },
    { enforceSso: false, enforceMfa: true },
    { enforceSso: true, enforceMfa: true },
  ])('never creates a session with workspace policy %j', async (policy) => {
    const f = fixture(policy);
    const result = await f.service.passwordReset(
      { token: 'synthetic-reset', newPassword: 'synthetic-password' },
      f.workspace as any,
    );
    expect(result).toEqual({ requiresLogin: true });
    expect(f.sessions.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('rejects a token exactly at its expiration boundary', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-11-18T00:00:00Z'));
      const f = fixture({ enforceSso: false, enforceMfa: false });
      f.token.expiresAt = new Date();
      await expect(
        f.service.passwordReset(
          { token: 'synthetic-reset', newPassword: 'synthetic-password' },
          f.workspace as any,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(f.sessions.createSessionAndToken).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
