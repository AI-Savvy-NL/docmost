import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { issueLicense, type LicenseClaims } from '@wikisavvy/license';
import {
  up,
  down,
} from '../../database/migrations/20261115T173500-wikisavvy-licenses';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { WikisavvyLicenseRepo } from './license.repo';
import { LicensingService } from './licensing.service';

const url = process.env.WIKISAVVY_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('WikiSavvy licensing with isolated PostgreSQL', () => {
  let root: Kysely<any>;
  let db: Kysely<any>;
  let repository: WikisavvyLicenseRepo;
  let service: LicensingService;
  const schema = 'wikisavvy_test_' + randomBytes(8).toString('hex');
  const workspaceId = randomUUID();
  const otherWorkspace = randomUUID();
  const owner = randomUUID();
  const keys = generateKeyPairSync('ed25519');
  const now = Date.now();
  const claims: LicenseClaims = {
    version: 1,
    product: 'wikisavvy',
    edition: 'enterprise',
    licenseId: randomUUID(),
    workspaceId,
    licensee: 'Integration test',
    seats: 2,
    capabilities: [],
    issuedAt: new Date(now - 60000).toISOString(),
    notBefore: new Date(now - 60000).toISOString(),
    expiresAt: new Date(now + 3600000).toISOString(),
  };
  const envelope = issueLicense(claims, 'test', keys.privateKey);

  beforeAll(async () => {
    const parsed = new URL(url);
    if (
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/wikisavvy_test'
    ) {
      throw new Error('Refusing a non-local licensing test database');
    }
    root = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 5, onnotice: () => {} }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    await root.schema.createSchema(schema).execute();
    db = root.withSchema(schema);
    await db.schema
      .createTable('workspaces')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .execute();
    await db.schema
      .createTable('users')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('workspaceId', 'uuid', (c) => c.notNull())
      .addColumn('deactivatedAt', 'timestamptz')
      .addColumn('deletedAt', 'timestamptz')
      .execute();
    await db
      .insertInto('workspaces')
      .values([{ id: workspaceId }, { id: otherWorkspace }])
      .execute();
    await up(db);
    repository = new WikisavvyLicenseRepo(db as any);
    const secret = randomBytes(32).toString('hex');
    service = new LicensingService(
      repository,
      {
        getKeys: () => ({
          test: keys.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        }),
      } as any,
      new EncryptionService({ getAppSecret: () => secret } as any),
    );
  });
  beforeEach(async () => {
    await db.deleteFrom('wikisavvyLicenseEvents').execute();
    await db.deleteFrom('wikisavvyLicenses').execute();
    await db.deleteFrom('users').execute();
    await db.insertInto('users').values({ id: owner, workspaceId }).execute();
  });
  afterAll(async () => {
    if (root) {
      await root.schema.dropSchema(schema).cascade().execute();
      await root.destroy();
    }
  });

  it('persists encrypted licenses and activation/removal events atomically', async () => {
    await service.activate(workspaceId, owner, envelope);
    const row = await repository.find(workspaceId);
    expect(row.encryptedLicense === envelope).toBe(false);
    expect((await service.status(workspaceId)).edition).toBe('enterprise');
    await service.remove(workspaceId, owner);
    expect(await repository.find(workspaceId)).toBeUndefined();
    const events = await db
      .selectFrom('wikisavvyLicenseEvents')
      .selectAll()
      .execute();
    expect(events.map((event) => event.action).sort()).toEqual([
      'activated',
      'removed',
    ]);
    expect(JSON.stringify(events).includes(envelope)).toBe(false);
  });

  it('leaves an existing license intact after a failed replacement', async () => {
    await service.activate(workspaceId, owner, envelope);
    const before = (await repository.find(workspaceId)).encryptedLicense;
    await expect(
      service.activate(workspaceId, owner, envelope + 'tampered'),
    ).rejects.toThrow();
    expect(
      (await repository.find(workspaceId)).encryptedLicense === before,
    ).toBe(true);
    expect(await repository.find(otherWorkspace)).toBeUndefined();
  });

  it('excludes deactivated and deleted accounts from the seat count', async () => {
    await db
      .insertInto('users')
      .values([
        { id: randomUUID(), workspaceId, deactivatedAt: new Date() },
        { id: randomUUID(), workspaceId, deletedAt: new Date() },
        { id: randomUUID(), workspaceId: otherWorkspace },
      ])
      .execute();
    expect(await repository.activeMembers(workspaceId)).toBe(1);
  });

  it('admits only one concurrent member into the final licensed seat', async () => {
    await service.activate(workspaceId, owner, envelope);
    const admit = () =>
      repository.transaction(async (trx) => {
        await service.assertSeatAvailable(workspaceId, trx);
        await trx
          .insertInto('users')
          .values({ id: randomUUID(), workspaceId })
          .execute();
      });
    const results = await Promise.allSettled([admit(), admit()]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(await repository.activeMembers(workspaceId)).toBe(2);
  });

  it('rolls back only the added tables and can migrate up again', async () => {
    await down(db);
    expect(await repository.activeMembers(workspaceId)).toBe(1);
    const result = await sql<{
      relation: string | null;
    }>`select to_regclass(${schema + '.wikisavvy_licenses'}) as relation`.execute(
      root,
    );
    expect(result.rows[0].relation).toBeNull();
    await up(db);
    expect(await repository.find(workspaceId)).toBeUndefined();
  });
});
