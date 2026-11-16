import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { issueLicense, type LicenseClaims } from '@wikisavvy/license';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { LicensingService } from './licensing.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const keys = generateKeyPairSync('ed25519');
const claims: LicenseClaims = {
  version: 1,
  product: 'wikisavvy',
  edition: 'enterprise',
  licenseId: '22222222-2222-4222-8222-222222222222',
  workspaceId,
  licensee: 'Test organization',
  seats: 2,
  capabilities: ['wikisavvy.page-permissions'],
  issuedAt: '2026-11-01T00:00:00.000Z',
  notBefore: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-12-01T00:00:00.000Z',
};

function buildService() {
  let row: any = null;
  let active = 1;
  const trx = {} as any;
  const repository = {
    transaction: (callback: (value: any) => unknown) => callback(trx),
    lockWorkspace: jest.fn(),
    find: jest.fn(async () => row),
    activeMembers: jest.fn(async () => active),
    save: jest.fn(async (_workspace: string, encryptedLicense: string) => {
      row = { encryptedLicense };
    }),
    remove: jest.fn(async () => {
      row = null;
    }),
    recordEvent: jest.fn(),
  };
  const trust = {
    getKeys: () => ({
      primary: keys.publicKey
        .export({ format: 'pem', type: 'spki' })
        .toString(),
    }),
  };
  const secret = randomBytes(32).toString('hex');
  const encryption = new EncryptionService({
    getAppSecret: () => secret,
  } as any);
  const service = new LicensingService(
    repository as any,
    trust as any,
    encryption,
  );
  return {
    service,
    repository,
    trx,
    setActive: (count: number) => {
      active = count;
    },
  };
}

describe('WikiSavvy licensing service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-15T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('keeps Community available without a license', async () => {
    const { service, trx } = buildService();
    expect((await service.status(workspaceId)).edition).toBe('community');
    await expect(
      service.assertSeatAvailable(workspaceId, trx),
    ).resolves.toBeUndefined();
  });

  it('stores only encrypted envelopes and never returns them', async () => {
    const { service, repository } = buildService();
    const envelope = issueLicense(claims, 'primary', keys.privateKey);
    const result = await service.activate(workspaceId, 'owner', envelope);
    expect(repository.save.mock.calls[0][1] === envelope).toBe(false);
    expect(JSON.stringify(result).includes(envelope)).toBe(false);
    expect(result.edition).toBe('enterprise');
    expect(result.features).toEqual([]);
    expect(result.license.licenseId).toBe(claims.licenseId);
  });

  it('rejects a different workspace without changing the stored license', async () => {
    const { service, repository } = buildService();
    const envelope = issueLicense(
      { ...claims, workspaceId: '33333333-3333-4333-8333-333333333333' },
      'primary',
      keys.privateKey,
    );
    await expect(
      service.activate(workspaceId, 'owner', envelope),
    ).rejects.toThrow('Invalid');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('warns over-seat installations and rejects only new admissions', async () => {
    const { service, setActive, repository, trx } = buildService();
    await service.activate(
      workspaceId,
      'owner',
      issueLicense(claims, 'primary', keys.privateKey),
    );
    setActive(3);
    expect((await service.status(workspaceId)).seats.overLimit).toBe(true);
    await expect(service.assertSeatAvailable(workspaceId, trx)).rejects.toThrow(
      'seat limit',
    );
    expect(repository.lockWorkspace).toHaveBeenCalledWith(workspaceId, trx);
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('uses the signed expiry for grace, including after removal and reactivation', async () => {
    const { service } = buildService();
    const envelope = issueLicense(claims, 'primary', keys.privateKey);
    await service.activate(workspaceId, 'owner', envelope);
    jest.setSystemTime(new Date('2026-12-10T00:00:00Z'));
    await service.remove(workspaceId, 'owner');
    const result = await service.activate(workspaceId, 'owner', envelope);
    expect(result.status).toBe('grace');
    expect(result.license.graceEndsAt).toBe('2026-12-31T00:00:00.000Z');
  });

  it('falls back to Community after grace without deleting stored data', async () => {
    const { service, repository, trx, setActive } = buildService();
    await service.activate(
      workspaceId,
      'owner',
      issueLicense(claims, 'primary', keys.privateKey),
    );
    setActive(3);
    jest.setSystemTime(new Date('2026-12-31T00:00:00Z'));
    const result = await service.status(workspaceId);
    expect(result.status).toBe('expired');
    expect(result.edition).toBe('community');
    await expect(
      service.assertSeatAvailable(workspaceId, trx),
    ).resolves.toBeUndefined();
    expect(repository.remove).not.toHaveBeenCalled();
  });

  it('rejects future and expired replacement keys atomically', async () => {
    const { service, repository } = buildService();
    await service.activate(
      workspaceId,
      'owner',
      issueLicense(claims, 'primary', keys.privateKey),
    );
    repository.save.mockClear();
    const future = { ...claims, notBefore: '2026-11-20T00:00:00.000Z' };
    await expect(
      service.activate(
        workspaceId,
        'owner',
        issueLicense(future, 'primary', keys.privateKey),
      ),
    ).rejects.toThrow();
    jest.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    await expect(
      service.activate(
        workspaceId,
        'owner',
        issueLicense(claims, 'primary', keys.privateKey),
      ),
    ).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });
});
