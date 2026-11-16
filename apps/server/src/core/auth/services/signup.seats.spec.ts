import { ForbiddenException } from '@nestjs/common';
import { SignupService } from './signup.service';

describe('Signup licensed seat boundary', () => {
  it('checks the seat before creating a user in an existing workspace', async () => {
    const trx = {};
    const userRepo = { findByEmail: jest.fn(), insertUser: jest.fn() };
    const licensing = {
      assertSeatAvailable: jest
        .fn()
        .mockRejectedValue(
          new ForbiddenException('Licensed seat limit reached'),
        ),
    };
    const service = new SignupService(
      userRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {
        transaction: () => ({ execute: (callback: any) => callback(trx) }),
      } as any,
      {} as any,
      licensing as any,
    );
    await expect(
      service.signup(
        {
          name: 'Test',
          email: 'test@example.invalid',
          password: 'synthetic-test-value',
        } as any,
        'workspace',
      ),
    ).rejects.toThrow('seat limit');
    expect(licensing.assertSeatAvailable).toHaveBeenCalledWith(
      'workspace',
      trx,
    );
    expect(userRepo.insertUser).not.toHaveBeenCalled();
  });
});
