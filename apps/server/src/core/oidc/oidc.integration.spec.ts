import { randomBytes, randomUUID } from 'node:crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { WikisavvyOidcRepo } from './oidc.repo';
import {
  up,
  down,
} from '../../database/migrations/20261118T070000-wikisavvy-oidc-foundation';

const url = process.env.WIKISAVVY_OIDC_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Independent OIDC storage with isolated PostgreSQL', () => {
  let root: Kysely<any>;
  let db: Kysely<any>;
  let repo: WikisavvyOidcRepo;
  let providerId: string;
  const schema = 'oidc_test_' + randomBytes(8).toString('hex');
  const workspaceId = randomUUID();
  const foreignWorkspace = randomUUID();
  const userId = randomUUID();
  const otherUser = randomUUID();
  const foreignUser = randomUUID();
  const issuer = 'https://identity.example.invalid/application/o/wiki/';

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/wikisavvy_oidc_test'
    ) {
      throw new Error('Refusing a non-local OIDC test database');
    }
    root = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url!, { max: 6, onnotice: () => {} }),
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
      .addColumn('workspaceId', 'uuid', (c) =>
        c.notNull().references('workspaces.id'),
      )
      .execute();
    await up(db);
    repo = new WikisavvyOidcRepo(db as any);
    await db
      .insertInto('workspaces')
      .values([{ id: workspaceId }, { id: foreignWorkspace }])
      .execute();
    await db
      .insertInto('users')
      .values([
        { id: userId, workspaceId },
        { id: otherUser, workspaceId },
        { id: foreignUser, workspaceId: foreignWorkspace },
      ])
      .execute();
  });

  beforeEach(async () => {
    await db.deleteFrom('wikisavvyOidcIdentities').execute();
    await db.deleteFrom('wikisavvyOidcProviders').execute();
    providerId = (
      await repo.insertProvider({
        workspaceId,
        issuer,
        clientId: 'public-fixture-client-id',
      })
    ).id;
  });

  afterAll(async () => {
    if (root) {
      await root.schema.dropSchema(schema).cascade().execute();
      await root.destroy();
    }
  });

  function identity(change: Record<string, unknown> = {}) {
    return {
      workspaceId,
      providerId,
      issuer,
      subject: 'exact-subject',
      userId,
      ...change,
    };
  }
  function bind(change: Record<string, unknown> = {}) {
    return db
      .transaction()
      .execute((trx) =>
        repo.insertIdentity(identity(change) as any, trx as any),
      );
  }
  function direct(change: Record<string, unknown> = {}) {
    return db
      .insertInto('wikisavvyOidcIdentities')
      .values(identity(change))
      .execute();
  }

  it('stores public configuration disabled without touching legacy tables', async () => {
    const provider = await repo.findProvider(workspaceId, providerId);
    expect(provider?.isEnabled).toBe(false);
    expect(provider?.issuer).toBe(issuer);
    expect(Object.keys(provider!).sort()).toEqual([
      'clientId',
      'createdAt',
      'id',
      'isEnabled',
      'issuer',
      'workspaceId',
    ]);
    const relation = await sql<{
      name: string | null;
    }>`SELECT to_regclass(${schema + '.auth_providers'}) AS name`.execute(root);
    expect(relation.rows[0].name).toBeNull();
  });

  it('requires an explicit transaction for identity writes', async () => {
    await expect(repo.insertIdentity(identity(), db as any)).rejects.toThrow(
      'requires a transaction',
    );
    expect(
      await repo.findIdentity(workspaceId, issuer, 'exact-subject'),
    ).toBeUndefined();
  });

  it('stores an exact identity and scopes every lookup by workspace', async () => {
    await bind();
    const row = await repo.findIdentity(workspaceId, issuer, 'exact-subject');
    expect(row?.userId).toBe(userId);
    expect(row?.providerId).toBe(providerId);
    expect(
      await repo.findIdentity(foreignWorkspace, issuer, 'exact-subject'),
    ).toBeUndefined();
    expect(
      await repo.findProvider(foreignWorkspace, providerId),
    ).toBeUndefined();
  });

  it.each([
    'http://identity.example.invalid/',
    'https://user:synthetic@identity.example.invalid/',
    'https://identity.example.invalid/?query=yes',
    'https://identity.example.invalid/#fragment',
    'https://identity.example.invalid/?',
    'https://identity.example.invalid/#',
    ' https://identity.example.invalid/',
    'https:\\\\identity.example.invalid',
    'https:///identity.example.invalid/',
    'https://identity.example.invalid/\npath',
    'https://@identity.example.invalid/',
    'not-a-url',
  ])('rejects invalid issuer shape: %s', async (value) => {
    await expect(
      repo.insertProvider({ workspaceId, issuer: value, clientId: 'fixture' }),
    ).rejects.toThrow('Invalid OIDC issuer');
  });

  it.each(['', ' '.repeat(2), 'x'.repeat(513)])(
    'rejects invalid client identifiers',
    async (clientId) => {
      await expect(
        repo.insertProvider({ workspaceId, issuer, clientId }),
      ).rejects.toThrow('Invalid OIDC client identifier');
    },
  );

  it.each(['', 'x'.repeat(256)])(
    'rejects invalid identity subjects',
    async (subject) => {
      await expect(bind({ subject })).rejects.toThrow('Invalid OIDC subject');
    },
  );

  it.each([
    { userId: foreignUser },
    { workspaceId: foreignWorkspace },
    { issuer: 'https://different.example.invalid/' },
    { providerId: randomUUID() },
    { userId: randomUUID() },
  ])(
    'rejects invalid associations through repository and raw writes: %j',
    async (change) => {
      await expect(bind(change)).rejects.toMatchObject({ code: '23503' });
      await expect(direct(change)).rejects.toMatchObject({ code: '23503' });
      expect(
        await repo.findIdentity(workspaceId, issuer, 'exact-subject'),
      ).toBeUndefined();
    },
  );

  it('rejects a foreign provider even with an otherwise local account', async () => {
    const foreign = await repo.insertProvider({
      workspaceId: foreignWorkspace,
      issuer,
      clientId: 'foreign-public-client',
    });
    await expect(bind({ providerId: foreign.id })).rejects.toMatchObject({
      code: '23503',
    });
    await expect(direct({ providerId: foreign.id })).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('allows only one concurrent binding for the same issuer and subject', async () => {
    const results = await Promise.allSettled([
      bind(),
      bind({ userId: otherUser }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(
      await db.selectFrom('wikisavvyOidcIdentities').select('id').execute(),
    ).toHaveLength(1);
  });

  it('prevents duplicate identity assignment across client/provider records', async () => {
    const second = await repo.insertProvider({
      workspaceId,
      issuer,
      clientId: 'second-public-client',
    });
    await bind();
    await expect(
      bind({ providerId: second.id, userId: otherUser }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows only one subject per account and provider', async () => {
    await bind();
    await expect(bind({ subject: 'another-subject' })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('preserves case-sensitive subject identity and exact issuer spelling', async () => {
    await bind();
    expect(
      await repo.findIdentity(workspaceId, issuer, 'EXACT-SUBJECT'),
    ).toBeUndefined();
    expect(
      await repo.findIdentity(
        workspaceId,
        issuer.slice(0, -1),
        'exact-subject',
      ),
    ).toBeUndefined();
    await bind({ subject: 'EXACT-SUBJECT', userId: otherUser });
    expect(
      (await repo.findIdentity(workspaceId, issuer, 'EXACT-SUBJECT'))?.userId,
    ).toBe(otherUser);
  });

  it('isolates identical issuer/subject pairs between workspaces', async () => {
    const foreign = await repo.insertProvider({
      workspaceId: foreignWorkspace,
      issuer,
      clientId: 'foreign-public-client',
    });
    await bind();
    await bind({
      workspaceId: foreignWorkspace,
      providerId: foreign.id,
      userId: foreignUser,
    });
    expect(
      (await repo.findIdentity(workspaceId, issuer, 'exact-subject'))?.userId,
    ).toBe(userId);
    expect(
      (await repo.findIdentity(foreignWorkspace, issuer, 'exact-subject'))
        ?.userId,
    ).toBe(foreignUser);
  });

  it('does not normalize issuer case or subject whitespace', async () => {
    await bind();
    const variant = await repo.insertProvider({
      workspaceId,
      issuer: issuer.toUpperCase(),
      clientId: 'case-variant',
    });
    await bind({
      providerId: variant.id,
      issuer: issuer.toUpperCase(),
      userId: otherUser,
    });
    expect(
      (
        await repo.findIdentity(
          workspaceId,
          issuer.toUpperCase(),
          'exact-subject',
        )
      )?.userId,
    ).toBe(otherUser);
    expect(
      (await repo.findIdentity(workspaceId, issuer, 'exact-subject'))?.userId,
    ).toBe(userId);
    await bind({
      providerId: variant.id,
      issuer: issuer.toUpperCase(),
      subject: ' exact-subject ',
      userId,
    });
    expect(
      (
        await repo.findIdentity(
          workspaceId,
          issuer.toUpperCase(),
          ' exact-subject ',
        )
      )?.userId,
    ).toBe(userId);
  });

  it('accepts maximum-length ASCII issuer and subject keys', async () => {
    const prefix = 'https://identity.example.invalid/';
    const longestIssuer = prefix + 'x'.repeat(2048 - prefix.length);
    const subject = 's'.repeat(255);
    const longest = await repo.insertProvider({
      workspaceId,
      issuer: longestIssuer,
      clientId: 'longest-public-client',
    });
    await bind({ providerId: longest.id, issuer: longestIssuer, subject });
    expect(
      (await repo.findIdentity(workspaceId, longestIssuer, subject))?.userId,
    ).toBe(userId);
  });

  it('enforces nonempty identity keys on raw writes too', async () => {
    await expect(direct({ subject: '' })).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('rolls back a binding when its containing transaction fails', async () => {
    await expect(
      db.transaction().execute(async (trx) => {
        await repo.insertIdentity(identity(), trx as any);
        throw new Error('synthetic-proof-transaction-failure');
      }),
    ).rejects.toThrow('synthetic-proof-transaction-failure');
    expect(
      await repo.findIdentity(workspaceId, issuer, 'exact-subject'),
    ).toBeUndefined();
  });

  it('prevents linked provider issuer/workspace or account workspace reassignment', async () => {
    await bind();
    await expect(
      db
        .updateTable('wikisavvyOidcProviders')
        .set({ issuer: 'https://replacement.example.invalid/' })
        .where('id', '=', providerId)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .updateTable('wikisavvyOidcProviders')
        .set({ workspaceId: foreignWorkspace })
        .where('id', '=', providerId)
        .execute(),
    ).rejects.toThrow();
    await expect(
      db
        .updateTable('users')
        .set({ workspaceId: foreignWorkspace })
        .where('id', '=', userId)
        .execute(),
    ).rejects.toThrow();
  });

  it('keeps providers disabled even when unexpected enabling input is supplied', async () => {
    const row = await repo.insertProvider({
      workspaceId,
      issuer,
      clientId: 'extra-client',
      isEnabled: true,
    } as any);
    expect(row.isEnabled).toBe(false);
  });

  it('migrates down/up without changing existing workspace/account records', async () => {
    await bind();
    await down(db);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(3);
    expect(
      await db.selectFrom('workspaces').select('id').execute(),
    ).toHaveLength(2);
    await up(db);
    expect(
      await repo.findIdentity(workspaceId, issuer, 'exact-subject'),
    ).toBeUndefined();
    expect(await repo.findProvider(workspaceId, providerId)).toBeUndefined();
  });
});
