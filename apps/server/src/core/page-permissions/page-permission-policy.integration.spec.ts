import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ConflictException, ForbiddenException, Global, Module, NotFoundException, ValidationPipe } from '@nestjs/common';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { up as uuidMigration } from '../../database/migrations/20240324T085400-uuid_v7_fn';
import { up as userMigration } from '../../database/migrations/20240324T085600-users';
import { up as permissionMigration } from '../../database/migrations/20260224T233803-page-permissions';
import { PageRepo } from '../../database/repos/page/page.repo';
import { PagePermissionRepo } from '../../database/repos/page/page-permission.repo';
import { SpaceMemberRepo } from '../../database/repos/space/space-member.repo';
import { SpaceRepo } from '../../database/repos/space/space.repo';
import { UserRepo } from '../../database/repos/user/user.repo';
import { WikisavvyLicenseRepo } from '../licensing/license.repo';
import { WikisavvyPagePermissionPolicy } from './page-permission-policy';
import { WikisavvyPagePermissionRepo } from './page-permission.repo';
import { WikisavvyPagePermissionService } from './page-permission.service';
import { up as revisionMigration } from '../../database/migrations/20261117T145000-wikisavvy-page-permission-revisions';
import { Connection, Hocuspocus, MessageType } from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { AuthenticationExtension } from '../../collaboration/extensions/authentication.extension';
import { CollabProxySocket } from '../../collaboration/extensions/redis-sync/collab-proxy-socket';
import Redis from 'ioredis';
import { pack, unpack } from 'msgpackr';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { PassportModule } from '@nestjs/passport';
import { sign } from 'jsonwebtoken';
import { WikisavvyPagePermissionController } from './page-permission.controller';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { WorkspaceRepo } from '../../database/repos/workspace/workspace.repo';
import { UserSessionRepo } from '../../database/repos/session/user-session.repo';
import { SessionActivityService } from '../session/session-activity.service';
import { KYSELY_MODULE_CONNECTION_TOKEN } from 'nestjs-kysely';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { AUDIT_SERVICE } from '../../integrations/audit/audit.service';
import { WsService } from '../../ws/ws.service';
import { WikisavvyPagePermissionModule } from './page-permission.module';
import { up as licenseMigration } from '../../database/migrations/20261115T173500-wikisavvy-licenses';
import { LicensingService } from '../licensing/licensing.service';
import { EncryptionPurpose } from '../../integrations/encryption/encryption.service';
import { issueLicense, type LicenseClaims } from '@wikisavvy/license';

const url = process.env.WIKISAVVY_PERMISSION_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Page permission policy with isolated PostgreSQL', () => {
  let db: Kysely<any>;
  let pages: PageRepo;
  let permissions: PagePermissionRepo;
  let spaces: SpaceMemberRepo;
  let policy: WikisavvyPagePermissionPolicy;
  let licensing: any;
  let management: WikisavvyPagePermissionService;
  let managementRepo: WikisavvyPagePermissionRepo;
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const effects = { afterChange: jest.fn().mockResolvedValue(undefined) };
  const workspaceId = randomUUID();
  const otherWorkspace = randomUUID();
  const userId = randomUUID();
  const otherUser = randomUUID();
  const spaceId = randomUUID();
  const groupId = randomUUID();
  const pageId = randomUUID();
  const childId = randomUUID();
  const actor = { id: userId, workspaceId };
  const permissionCache = {
    get: jest.fn().mockResolvedValue({ v: { hasAnyRestriction: false, canAccess: true, canEdit: true } }),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const spaceCache = {
    get: jest.fn().mockResolvedValue({ v: [{ userId, role: 'writer' }] }),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const manage = (who = actor, id = pageId) =>
    db.transaction().execute((trx) => policy.assertCanManage(who, workspaceId, id, trx as any));
  async function restrict(id: string, grants: Array<{ userId?: string; groupId?: string; role: string }>) {
    const accessId = randomUUID();
    await db.insertInto('pageAccess').values({
      id: accessId, pageId: id, spaceId, workspaceId, accessLevel: 'restricted', creatorId: userId,
    }).execute();
    for (const grant of grants) {
      await db.insertInto('pagePermissions').values({
        id: randomUUID(), pageAccessId: accessId, ...grant, addedById: userId,
      }).execute();
    }
    return accessId;
  }

  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/wikisavvy_permission_test') {
      throw new Error('Refusing a non-local permission test database');
    }
    db = new Kysely({
      dialect: new PostgresJSDialect({ postgres: postgres(url, { max: 5, onnotice: () => {} }) }),
      plugins: [new CamelCasePlugin()],
    });
    await uuidMigration(db);
    await db.schema.createTable('workspaces').addColumn('id', 'uuid', (c) => c.primaryKey()).execute();
    await userMigration(db);
    await db.schema.alterTable('users').addColumn('hasGeneratedPassword', 'boolean', (c) => c.defaultTo(false)).execute();
    for (const table of ['spaces', 'groups'] as const) {
      await db.schema.createTable(table)
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('workspaceId', 'uuid', (c) => c.notNull())
        .addColumn('name', 'varchar')
        .execute();
    }
    await db.schema.alterTable('spaces').addColumn('deletedAt', 'timestamptz').execute();
    await db.schema.alterTable('spaces').addColumn('archivedAt', 'timestamptz').execute();
    await db.schema.createTable('publicSpaces')
      .addColumn('id', 'uuid').addColumn('spaceId', 'uuid').addColumn('enabled', 'boolean').execute();
    await db.schema.createTable('groupUsers').addColumn('groupId', 'uuid').addColumn('userId', 'uuid').execute();
    await db.schema.createTable('spaceMembers')
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`gen_uuid_v7()`))
      .addColumn('spaceId', 'uuid').addColumn('userId', 'uuid').addColumn('groupId', 'uuid')
      .addColumn('role', 'varchar').execute();
    await db.schema.createTable('pages')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('parentPageId', 'uuid').addColumn('workspaceId', 'uuid').addColumn('spaceId', 'uuid')
      .addColumn('creatorId', 'uuid').addColumn('lastUpdatedById', 'uuid')
      .addColumn('isLocked', 'boolean').addColumn('isBase', 'boolean')
      .addColumn('createdAt', 'timestamptz', (c) => c.defaultTo(sql`now()`))
      .addColumn('updatedAt', 'timestamptz', (c) => c.defaultTo(sql`now()`))
      .addColumn('deletedAt', 'timestamptz').addColumn('contributorIds', sql`uuid[]`)
      .addColumn('slugId', 'varchar').addColumn('title', 'varchar')
      .addColumn('icon', 'varchar').addColumn('position', 'varchar')
      .addColumn('coverPhoto', 'varchar').addColumn('coverPosition', 'jsonb')
      .addColumn('coverAttribution', 'jsonb').execute();
    await permissionMigration(db);
    await revisionMigration(db);
    await licenseMigration(db);
    const spaceRepo = new SpaceRepo(db as any, new EventEmitter2());
    spaces = new SpaceMemberRepo(db as any, {} as any, spaceRepo, spaceCache as any);
    permissions = new PagePermissionRepo(db as any, {} as any, permissionCache as any);
    pages = new PageRepo(db as any, spaces, new EventEmitter2(), permissions);
    const licenseRepo = new WikisavvyLicenseRepo(db as any);
    licensing = {
      lockWorkspace: (id: string, trx: any) => licenseRepo.lockWorkspace(id, trx),
      status: jest.fn().mockResolvedValue({ status: 'valid', features: ['wikisavvy.page-permissions'] }),
    };
    policy = new WikisavvyPagePermissionPolicy(pages, new UserRepo(db as any), spaces, permissions, licensing, spaceRepo);
    managementRepo = new WikisavvyPagePermissionRepo(db as any, permissions);
    management = new WikisavvyPagePermissionService(managementRepo, policy, audit as any, effects as any);
  });

  describe('real PostgreSQL and multi-client Hocuspocus revocation', () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    async function until(predicate: () => boolean) {
      const deadline = Date.now() + 3000;
      while (!predicate() && Date.now() < deadline) await delay(5);
      expect(predicate()).toBe(true);
    }

    function frame(type: number, write: (encoder: encoding.Encoder) => void) {
      const encoder = encoding.createEncoder();
      encoding.writeVarString(encoder, `page.${childId}`);
      encoding.writeVarUint(encoder, type);
      write(encoder);
      return encoding.toUint8Array(encoder);
    }

    async function live(database = db) {
      const spaceRepo = new SpaceRepo(database as any, new EventEmitter2());
      const members = new SpaceMemberRepo(database as any, {} as any, spaceRepo, spaceCache as any);
      const permissionRepo = new PagePermissionRepo(database as any, {} as any, permissionCache as any);
      const pageRepo = new PageRepo(database as any, members, new EventEmitter2(), permissionRepo);
      const subscriber = { on: jest.fn(), subscribe: jest.fn(), disconnect: jest.fn() };
      const authentication = new AuthenticationExtension(
        { verifyJwt: async (id: string) => ({ sub: id, workspaceId }) } as any,
        new UserRepo(database as any), pageRepo, members, permissionRepo,
        { getOrThrow: () => ({ duplicate: () => subscriber }) } as any, spaceRepo,
        database as any,
      );
      let connected: () => void;
      const instance = new Hocuspocus({
        extensions: [authentication],
        unloadImmediately: false,
        connected: async () => { connected(); },
      });
      const clients: ReturnType<Hocuspocus['handleConnection']>[] = [];
      cleanups.push(async () => {
        clients.forEach((client) => client.handleClose());
        await instance.hooks('onDestroy', { instance });
        for (const document of instance.documents.values()) document.destroy();
        instance.documents.clear();
      });
      async function connect(id: string) {
        const socket = { readyState: 1, send: jest.fn(), close: jest.fn() };
        const client = instance.handleConnection(socket, new Request('http://localhost'));
        clients.push(client);
        const ready = new Promise<void>((resolve) => { connected = resolve; });
        client.handleMessage(frame(MessageType.Auth, (encoder) => {
          encoding.writeVarUint(encoder, AuthMessageType.Token);
          encoding.writeVarString(encoder, id);
        }));
        await ready;
        const document = instance.documents.get(`page.${childId}`);
        const connection = document.getConnections().find((conn) => conn.context.user.id === id);
        const types = () => socket.send.mock.calls.map(([bytes]) => {
          const decoder = decoding.createDecoder(bytes);
          decoding.readVarString(decoder);
          const type = decoding.readVarUint(decoder);
          if (type === MessageType.Stateless) {
            const payload = decoding.readVarString(decoder);
            if (['none', 'read', 'write'].some((access) => payload === JSON.stringify({ type: 'page.permissions', access }))) return 'permissions';
          }
          return type;
        });
        socket.send.mockClear();
        return { client, socket, connection, document, types };
      }
      return { connect, subscriber, pageRepo };
    }

    it.each(['ancestor', 'group', 'membership', 'account'])(
      'rejects idle delivery after a committed %s revocation without pubsub invalidation',
      async (kind) => {
        await db.insertInto('groupUsers').values({ userId, groupId }).execute();
        await restrict(pageId, [
          { groupId, role: 'writer' }, { userId: otherUser, role: 'writer' },
        ]);
        await restrict(childId, [
          { userId, role: 'writer' }, { userId: otherUser, role: 'writer' },
        ]);
        const { connect, subscriber } = await live();
        const viewer = await connect(userId);
        const writer = await connect(otherUser);
        viewer.document.broadcastStateless('before-revocation');
        await until(() => viewer.types().includes(MessageType.Stateless) && writer.types().includes(MessageType.Stateless));
        viewer.socket.send.mockClear();
        writer.socket.send.mockClear();
        if (kind === 'ancestor') {
          const snapshot = await management.info({ id: otherUser, workspaceId }, pageId);
          await management.set({ id: otherUser, workspaceId }, pageId, {
            revision: snapshot.revision, grants: [{ type: 'user', id: otherUser, role: 'writer' }],
          });
        } else if (kind === 'group') {
          await db.deleteFrom('groupUsers').where('userId', '=', userId).execute();
        } else if (kind === 'membership') {
          await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
        } else {
          await db.updateTable('users').set({ deactivatedAt: new Date() }).where('id', '=', userId).execute();
        }
        viewer.document.broadcastStateless('private-after-revocation');
        await until(() => !viewer.document.hasConnection(viewer.connection));
        await until(() => writer.types().includes(MessageType.Stateless));
        expect(viewer.types()).not.toContain(MessageType.Stateless);
        expect(subscriber.subscribe).not.toHaveBeenCalled();
      },
    );

    it('rejects Yjs writes after a committed writer-to-reader downgrade and retains readable delivery', async () => {
      await restrict(childId, [{ userId, role: 'writer' }, { userId: otherUser, role: 'writer' }]);
      const { connect } = await live();
      const viewer = await connect(userId);
      await connect(otherUser);
      const snapshot = await management.info({ id: otherUser, workspaceId }, childId);
      await management.set({ id: otherUser, workspaceId }, childId, {
        revision: snapshot.revision,
        grants: [{ type: 'user', id: userId, role: 'reader' }, { type: 'user', id: otherUser, role: 'writer' }],
      });
      const update = new Y.Doc();
      update.getText('content').insert(0, 'denied');
      viewer.client.handleMessage(frame(MessageType.Sync, (encoder) => {
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(update));
      }));
      await viewer.connection.waitForPendingMessages();
      expect(viewer.document.getText('content').toString()).toBe('');
      expect(viewer.connection.readOnly).toBe(true);
      viewer.socket.send.mockClear();
      viewer.document.broadcastStateless('readable');
      await until(() => viewer.types().includes(MessageType.Stateless));
      expect(viewer.document.hasConnection(viewer.connection)).toBe(true);
      update.destroy();
      const current = await management.info({ id: otherUser, workspaceId }, childId);
      await management.set({ id: otherUser, workspaceId }, childId, {
        revision: current.revision,
        grants: [{ type: 'user', id: userId, role: 'writer' }, { type: 'user', id: otherUser, role: 'writer' }],
      });
      viewer.socket.send.mockClear();
      viewer.document.broadcastStateless('restored-writer');
      await until(() => viewer.types().includes(MessageType.Stateless));
      expect(viewer.connection.readOnly).toBe(true);
      const restored = new Y.Doc();
      restored.getText('content').insert(0, 'restored');
      viewer.client.handleMessage(frame(MessageType.Sync, (encoder) => {
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(restored));
      }));
      await viewer.connection.waitForPendingMessages();
      expect(viewer.document.getText('content').toString()).toBe('restored');
      expect(viewer.connection.readOnly).toBe(false);
      restored.destroy();
    });

    it('closes a live recipient when its real PostgreSQL pool is unavailable', async () => {
      const database = new Kysely({
        dialect: new PostgresJSDialect({ postgres: postgres(url, { max: 2, onnotice: () => {} }) }),
        plugins: [new CamelCasePlugin()],
      });
      const { connect } = await live(database);
      const viewer = await connect(userId);
      await database.destroy();
      viewer.document.broadcastStateless('private-on-database-failure');
      await until(() => !viewer.document.hasConnection(viewer.connection));
      expect(viewer.types()).not.toContain(MessageType.Stateless);
    });

    it('does not combine a pre-move space role with post-move restrictions', async () => {
      const { connect, pageRepo } = await live();
      const viewer = await connect(userId);
      await restrict(pageId, [{ userId: otherUser, role: 'writer' }]);
      const destination = randomUUID();
      await db.insertInto('spaces').values({ id: destination, workspaceId }).execute();
      const find = pageRepo.findById.bind(pageRepo);
      const spy = jest.spyOn(pageRepo, 'findById').mockImplementationOnce(async (...args) => {
        const beforeMove = await find(...args);
        await db.updateTable('pages').set({ spaceId: destination, parentPageId: null })
          .where('id', '=', childId).execute();
        return beforeMove;
      });
      try {
        viewer.document.broadcastStateless('private-moved-page');
        await until(() => !viewer.document.hasConnection(viewer.connection));
        expect(viewer.types()).not.toContain(MessageType.Stateless);
      } finally {
        spy.mockRestore();
      }
    });

    const redisTest = process.env.WIKISAVVY_PERMISSION_TEST_REDIS_URL ? it : it.skip;
    redisTest.each(['revocation', 'offline'])('guards real Redis proxy egress during %s', async (kind) => {
      const redisUrl = new URL(process.env.WIKISAVVY_PERMISSION_TEST_REDIS_URL);
      if (redisUrl.hostname !== '127.0.0.1') throw new Error('Refusing non-local Redis fixture');
      const pub = new Redis(redisUrl.href);
      const sub = new Redis(redisUrl.href);
      pub.on('error', () => {});
      sub.on('error', () => {});
      const received: Uint8Array[] = [];
      const channel = `wikisavvy-test:${randomUUID()}`;
      sub.on('messageBuffer', (_channel, bytes) => {
        const message = unpack(bytes);
        if (message.type === 'send') received.push(message.message);
      });
      const { connect } = await live();
      const owner = await connect(otherUser);
      let connection: Connection;
      try {
        await pub.ping();
        await sub.subscribe(channel);
        const proxy = new CollabProxySocket(pub, pack, channel, 'proxy-socket');
        connection = new Connection(proxy, new Request('http://localhost'), owner.document, 'proxy-socket', {
          user: { id: userId, workspaceId },
        });
        owner.document.broadcastStateless('before');
        const types = () => received.map((bytes) => {
          const decoder = decoding.createDecoder(bytes);
          decoding.readVarString(decoder);
          const type = decoding.readVarUint(decoder);
          if (type === MessageType.Stateless) {
            const payload = decoding.readVarString(decoder);
            if (['none', 'read', 'write'].some((access) => payload === JSON.stringify({ type: 'page.permissions', access }))) return 'permissions';
          }
          return type;
        });
        await until(() => types().includes(MessageType.Stateless));
        received.length = 0;
        if (kind === 'revocation') {
          await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
        } else {
          pub.disconnect();
        }
        owner.document.broadcastStateless('private-after');
        await until(() => !owner.document.hasConnection(connection));
        expect(types()).not.toContain(MessageType.Stateless);
      } finally {
        connection?.close();
        pub.disconnect();
        sub.disconnect();
      }
    });
  });
  beforeEach(async () => {
    for (const table of ['wikisavvyLicenseEvents', 'wikisavvyLicenses', 'wikisavvyPagePermissionRevisions', 'pagePermissions', 'pageAccess', 'spaceMembers', 'groupUsers', 'pages', 'groups', 'spaces', 'users', 'workspaces']) {
      await db.deleteFrom(table).execute();
    }
    await db.insertInto('workspaces').values([{ id: workspaceId }, { id: otherWorkspace }]).execute();
    await db.insertInto('users').values([
      { id: userId, workspaceId, role: 'member', email: 'writer@example.invalid' },
      { id: otherUser, workspaceId, role: 'owner', email: 'other@example.invalid' },
    ]).execute();
    await db.insertInto('spaces').values({ id: spaceId, workspaceId }).execute();
    await db.insertInto('groups').values({ id: groupId, workspaceId, name: 'Team' }).execute();
    await db.insertInto('spaceMembers').values([
      { userId, spaceId, role: 'writer' }, { userId: otherUser, spaceId, role: 'writer' },
    ]).execute();
    await db.insertInto('pages').values([
      { id: pageId, spaceId, workspaceId, slugId: 'parent' },
      { id: childId, spaceId, workspaceId, parentPageId: pageId, slugId: 'child' },
    ]).execute();
    jest.clearAllMocks();
    audit.log.mockReset().mockResolvedValue(undefined);
    effects.afterChange.mockReset().mockResolvedValue(undefined);
    licensing.status.mockResolvedValue({ status: 'valid', features: ['wikisavvy.page-permissions'] });
  });
  afterAll(async () => {
    if (db) await db.destroy();
  });

  it('authorizes unrestricted space writers using real repositories without touching caches', async () => {
    await expect(manage()).resolves.toMatchObject({ id: pageId });
    expect(permissionCache.get).not.toHaveBeenCalled();
    expect(permissionCache.set).not.toHaveBeenCalled();
    expect(spaceCache.get).not.toHaveBeenCalled();
    expect(spaceCache.set).not.toHaveBeenCalled();
  });
  it('denies unrestricted space readers despite a stale cached writer allow', async () => {
    await db.updateTable('spaceMembers').set({ role: 'reader' }).where('userId', '=', userId).execute();
    await expect(manage()).rejects.toThrow(ForbiddenException);
    expect(spaceCache.get).not.toHaveBeenCalled();
  });
  it('checks ordinary authorization callers freshly even when stale allows are cached', async () => {
    await restrict(pageId, []);
    await db.updateTable('spaceMembers').set({ role: 'reader' }).where('userId', '=', userId).execute();
    expect(await permissions.canUserEditPage(userId, pageId)).toEqual({
      hasAnyRestriction: true, canAccess: false, canEdit: false,
    });
    expect(await permissions.canUserEditPage(userId, pageId, { skipCache: true })).toEqual({
      hasAnyRestriction: true, canAccess: false, canEdit: false,
    });
    expect(await spaces.getUserSpaceRoles(userId, spaceId)).toEqual([{ userId, role: 'reader' }]);
    expect(await spaces.getUserSpaceRoles(userId, spaceId, { skipCache: true })).toEqual([{ userId, role: 'reader' }]);
    expect(permissionCache.get).not.toHaveBeenCalled();
    expect(spaceCache.get).not.toHaveBeenCalled();
  });
  it('does not make database authorization depend on Redis cache availability', async () => {
    permissionCache.get.mockRejectedValueOnce(new Error('cache unavailable'));
    spaceCache.get.mockRejectedValueOnce(new Error('cache unavailable'));
    try {
      expect(await permissions.canUserAccessPage(userId, pageId)).toBe(true);
      expect(await spaces.getUserSpaceRoles(userId, spaceId)).toEqual([{ userId, role: 'writer' }]);
      expect(permissionCache.get).not.toHaveBeenCalled();
      expect(spaceCache.get).not.toHaveBeenCalled();
    } finally {
      permissionCache.get.mockReset().mockResolvedValue({ v: { hasAnyRestriction: false, canAccess: true, canEdit: true } });
      spaceCache.get.mockReset().mockResolvedValue({ v: [{ userId, role: 'writer' }] });
    }
  });
  it('filters realtime recipients by active account and current space membership, not ACL grants alone', async () => {
    expect(await permissions.getUserIdsWithPageAccess(childId, [userId, otherUser])).toEqual(expect.arrayContaining([userId, otherUser]));
    await restrict(pageId, [{ userId, role: 'writer' }, { userId: otherUser, role: 'reader' }]);
    await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
    await db.updateTable('users').set({ deactivatedAt: new Date() }).where('id', '=', otherUser).execute();
    expect(await permissions.getUserIdsWithPageAccess(childId, [userId, otherUser])).toEqual([]);
  });
  it('does not authorize recipients for a missing page', async () => {
    expect(await permissions.getUserIdsWithPageAccess(randomUUID(), [userId])).toEqual([]);
  });
  it('requires permission on every restricted ancestor, even for a workspace owner', async () => {
    const parent = await restrict(pageId, [{ userId, role: 'reader' }]);
    await restrict(childId, [{ userId, role: 'writer' }, { userId: otherUser, role: 'writer' }]);
    await expect(manage(actor, childId)).resolves.toMatchObject({ id: childId });
    await expect(manage({ id: otherUser, workspaceId }, childId)).rejects.toThrow(ForbiddenException);
    await db.deleteFrom('pagePermissions').where('pageAccessId', '=', parent).execute();
    await expect(manage(actor, childId)).rejects.toThrow(ForbiddenException);
  });
  it('uses the nearest restricted writer rather than granting rights from a more distant writer', async () => {
    await restrict(pageId, [{ userId, role: 'writer' }]);
    await restrict(childId, [{ userId, role: 'reader' }]);
    await expect(manage(actor, childId)).rejects.toThrow(ForbiddenException);
  });
  it.each(['reader', 'writer'])('uses the highest direct/group role when the direct grant is %s', async (role) => {
    await db.insertInto('groupUsers').values({ groupId, userId }).execute();
    await restrict(pageId, [
      { userId, role }, { groupId, role: role === 'reader' ? 'writer' : 'reader' },
    ]);
    await expect(manage()).resolves.toMatchObject({ id: pageId });
  });
  it('keeps the core rule allowing effective page writers who are space readers', async () => {
    await db.updateTable('spaceMembers').set({ role: 'reader' }).where('userId', '=', userId).execute();
    await restrict(pageId, [{ userId, role: 'writer' }]);
    await expect(manage()).resolves.toMatchObject({ id: pageId });
  });
  it('denies a disabled account from the current database state', async () => {
    await db.updateTable('users').set({ deactivatedAt: new Date() }).where('id', '=', userId).execute();
    await expect(manage()).rejects.toThrow(ForbiddenException);
  });
  it('does not disclose a foreign page or accept foreign actor context', async () => {
    const foreignPage = randomUUID();
    await db.insertInto('pages').values({ id: foreignPage, workspaceId: otherWorkspace, spaceId }).execute();
    await expect(manage(actor, foreignPage)).rejects.toThrow(NotFoundException);
    await expect(manage({ ...actor, workspaceId: otherWorkspace })).rejects.toThrow(ForbiddenException);
  });
  it('rejects a page whose space is associated with another workspace', async () => {
    await db.updateTable('spaces').set({ workspaceId: otherWorkspace }).where('id', '=', spaceId).execute();
    await expect(manage()).rejects.toThrow(NotFoundException);
  });
  it('sees transaction-local restrictions and memberships even without an explicit skipCache flag', async () => {
    await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('spaceMembers').values({ userId, spaceId, role: 'reader' }).execute();
      const accessId = randomUUID();
      await trx.insertInto('pageAccess').values({
        id: accessId, pageId, spaceId, workspaceId, accessLevel: 'restricted',
      }).execute();
      expect(await spaces.getUserSpaceRoles(userId, spaceId, { trx: trx as any })).toEqual([{ userId, role: 'reader' }]);
      expect(await permissions.canUserEditPage(userId, pageId, { trx: trx as any })).toEqual({
        hasAnyRestriction: true, canAccess: false, canEdit: false,
      });
    });
    expect(spaceCache.get).not.toHaveBeenCalled();
    expect(permissionCache.get).not.toHaveBeenCalled();
  });
  it('sees group revocation in the transaction instead of trusting cached membership or access', async () => {
    await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
    await db.insertInto('spaceMembers').values({ groupId, spaceId, role: 'writer' }).execute();
    await db.insertInto('groupUsers').values({ groupId, userId }).execute();
    await restrict(pageId, [{ groupId, role: 'writer' }]);
    await expect(manage()).resolves.toMatchObject({ id: pageId });
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('groupUsers').where('userId', '=', userId).execute();
      await expect(policy.assertCanManage(actor, workspaceId, pageId, trx as any)).rejects.toThrow(ForbiddenException);
    });
  });
  it('rechecks a waiting manager after a preceding locked transaction revokes their write grant', async () => {
    const accessId = await restrict(pageId, [
      { userId, role: 'writer' }, { userId: otherUser, role: 'writer' },
    ]);
    let release: () => void;
    let ready: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const first = db.transaction().execute(async (trx) => {
      await policy.assertCanManage(actor, workspaceId, pageId, trx as any);
      await trx.updateTable('pagePermissions').set({ role: 'reader' })
        .where('pageAccessId', '=', accessId).where('userId', '=', otherUser).execute();
      ready();
      await hold;
    });
    await locked;
    let attempting: () => void;
    const attempted = new Promise<void>((resolve) => { attempting = resolve; });
    const original = pages.lockPageHierarchySpaces.bind(pages);
    const spy = jest.spyOn(pages, 'lockPageHierarchySpaces').mockImplementation((ids, trx) => {
      const waiting = original(ids, trx);
      attempting();
      return waiting;
    });
    try {
      const second = manage({ id: otherUser, workspaceId });
      const denied = expect(second).rejects.toThrow(ForbiddenException);
      await attempted;
      release();
      await first;
      await denied;
    } finally {
      release();
      await first;
      spy.mockRestore();
    }
  });
  it('allows direct restriction maintenance without consulting an expired or unavailable license', async () => {
    await restrict(pageId, [{ userId, role: 'writer' }]);
    licensing.status.mockRejectedValue(new Error('license store unavailable'));
    await db.transaction().execute((trx) => policy.assertCanSetRestriction(actor, workspaceId, pageId, trx as any));
    expect(licensing.status).not.toHaveBeenCalled();
  });
  it('gates creation of a new direct restriction even when the page inherits one', async () => {
    await restrict(pageId, [{ userId, role: 'writer' }]);
    licensing.status.mockResolvedValue({ status: 'expired', features: [] });
    await expect(
      db.transaction().execute((trx) => policy.assertCanSetRestriction(actor, workspaceId, childId, trx as any)),
    ).rejects.toThrow(ForbiddenException);
    expect(licensing.status).toHaveBeenCalled();
  });

  describe('authenticated HTTP management with real policy and PostgreSQL', () => {
    let app: NestFastifyApplication;
    let sessionActive = true;
    const sessionId = randomUUID();
    const signingMaterial = randomUUID();
    const token = (sub = userId, session = true) => sign({
      sub, workspaceId, type: 'access', ...(session ? { sessionId } : {}),
    }, signingMaterial, { expiresIn: '1h' });
    const request = (route: string, payload: object, bearer = token()) => app.inject({
      method: 'POST', url: `/wikisavvy/page-permissions/${route}`,
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, payload,
    });

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
        controllers: [WikisavvyPagePermissionController],
        providers: [
          JwtStrategy,
          { provide: WikisavvyPagePermissionService, useValue: management },
          { provide: UserRepo, useValue: new UserRepo(db as any) },
          { provide: WorkspaceRepo, useValue: { findById: async (id: string) => id === workspaceId ? { id } : undefined } },
          { provide: UserSessionRepo, useValue: { findActiveById: async () => sessionActive ? { userId, workspaceId } : undefined } },
          { provide: SessionActivityService, useValue: { trackActivity: jest.fn() } },
          { provide: EnvironmentService, useValue: { getAppSecret: () => signingMaterial, isCloud: () => false } },
        ],
      }).compile();
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, stopAtFirstError: true, transform: true }));
      app.getHttpAdapter().getInstance().addHook('onRequest', async (req) => {
        req.raw['workspaceId'] = workspaceId;
      });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });
    beforeEach(() => { sessionActive = true; });
    afterAll(async () => { await app?.close(); });

    it.each(['info', 'principals', 'set', 'remove'])('requires authentication on %s', async (route) => {
      expect((await request(route, { pageId }, '')).statusCode).toBe(401);
    });
    it('requires a current session rather than a legacy sessionless access token', async () => {
      expect((await request('info', { pageId }, token(userId, false))).statusCode).toBe(403);
      sessionActive = false;
      expect((await request('info', { pageId })).statusCode).toBe(401);
    });
    it('validates mutation DTOs before persisting any restriction', async () => {
      const initial = (await request('info', { pageId })).json();
      for (const payload of [
        { pageId: 'invalid', revision: initial.revision, grants: [] },
        { pageId, revision: 'invalid', grants: [] },
        { pageId, revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'admin' }] },
      ]) expect((await request('set', payload)).statusCode).toBe(400);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
    });
    it('provides manager state without owner-only license metadata and supports stale/expiry transitions', async () => {
      const response = await request('info', { pageId, workspaceId: otherWorkspace });
      expect(response.statusCode).toBe(200);
      const initial = response.json();
      expect(initial.canCreateRestriction).toBe(true);
      expect(response.body).not.toMatch(/licenseId|licensee|encryptedLicense|seats|trustConfigured/);
      const changed = await request('set', {
        pageId, revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      });
      expect(changed.statusCode).toBe(200);
      expect((await request('set', { pageId, revision: initial.revision, grants: [] })).statusCode).toBe(409);
      licensing.status.mockResolvedValue({ status: 'expired', features: [] });
      const maintained = await request('set', {
        pageId, revision: changed.json().revision,
        grants: [{ type: 'user', id: userId, role: 'writer' }, { type: 'user', id: otherUser, role: 'reader' }],
      });
      expect(maintained.statusCode).toBe(200);
      expect((await request('remove', { pageId, revision: maintained.json().revision })).statusCode).toBe(200);
      const removed = await request('info', { pageId });
      expect(removed.json().canCreateRestriction).toBe(false);
      expect((await request('set', {
        pageId, revision: removed.json().revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      })).statusCode).toBe(403);
    });
    it('denies management on the next HTTP request after grant or membership revocation', async () => {
      const accessId = await restrict(pageId, [{ userId, role: 'writer' }, { userId: otherUser, role: 'writer' }]);
      expect((await request('info', { pageId })).statusCode).toBe(200);
      await db.deleteFrom('pagePermissions').where('pageAccessId', '=', accessId).where('userId', '=', userId).execute();
      expect((await request('info', { pageId })).statusCode).toBe(403);
      await db.deleteFrom('pageAccess').where('id', '=', accessId).execute();
      await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
      expect((await request('principals', { pageId, query: '' })).statusCode).toBe(403);
    });
    it('does not disclose foreign page state or accept a deactivated account', async () => {
      const foreignPage = randomUUID();
      await db.insertInto('pages').values({ id: foreignPage, workspaceId: otherWorkspace, spaceId }).execute();
      expect((await request('info', { pageId: foreignPage })).statusCode).toBe(404);
      await db.updateTable('users').set({ deactivatedAt: new Date() }).where('id', '=', userId).execute();
      expect((await request('info', { pageId })).statusCode).toBe(401);
    });
    it('constructs the actual module and runs its real service/policy/effects dependency graph', async () => {
      const providers = [
        { provide: KYSELY_MODULE_CONNECTION_TOKEN(), useValue: db },
        { provide: PageRepo, useValue: pages },
        { provide: UserRepo, useValue: new UserRepo(db as any) },
        { provide: SpaceMemberRepo, useValue: spaces },
        { provide: PagePermissionRepo, useValue: permissions },
        { provide: SpaceRepo, useValue: new SpaceRepo(db as any, new EventEmitter2()) },
        { provide: UserSessionRepo, useValue: {} },
        { provide: EnvironmentService, useValue: {
          getAppSecret: () => signingMaterial, getJwtTokenExpiresIn: () => '1h', isCloud: () => false,
        } },
        { provide: EncryptionService, useValue: {} },
        { provide: AUDIT_SERVICE, useValue: audit },
        { provide: RedisService, useValue: { getOrThrow: () => ({ publish: async () => undefined }) } },
      ];
      @Global()
      @Module({ providers, exports: providers.map((provider) => provider.provide) })
      class FixtureDependencies {}
      const ws = { emitToSpace: jest.fn(), removeBaseSubscribersWithoutAccess: jest.fn(async () => {}) };
      const fixture = await Test.createTestingModule({
        imports: [FixtureDependencies, WikisavvyPagePermissionModule],
      }).overrideProvider(WsService).useValue(ws).compile();
      try {
        const service = fixture.get(WikisavvyPagePermissionService);
        expect(service instanceof WikisavvyPagePermissionService).toBe(true);
        await restrict(pageId, [{ userId, role: 'writer' }]);
        const initial = await service.state(actor, pageId);
        await service.set(actor, pageId, {
          revision: initial.revision,
          grants: [{ type: 'user', id: userId, role: 'writer' }, { type: 'user', id: otherUser, role: 'reader' }],
        });
        expect(ws.emitToSpace).toHaveBeenCalledWith(spaceId, { operation: 'refetchRootTreeNodeEvent', spaceId });
      } finally {
        await fixture.close();
      }
    });
  });

  describe('independent transactional management', () => {
    it.each(['valid', 'grace'])('uses a real signed/encrypted %s license and preserves maintenance after actual expiry', async (state) => {
      const pair = generateKeyPairSync('ed25519');
      const trust = { getKeys: () => ({ acceptance: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }) };
      const encryption = new EncryptionService({ getAppSecret: () => randomUUID() } as any);
      const repository = new WikisavvyLicenseRepo(db as any);
      const licensingService = new LicensingService(repository, trust as any, encryption);
      const spaceRepo = new SpaceRepo(db as any, new EventEmitter2());
      const licensedPolicy = new WikisavvyPagePermissionPolicy(
        pages, new UserRepo(db as any), spaces, permissions, licensingService, spaceRepo,
      );
      const licensedManagement = new WikisavvyPagePermissionService(managementRepo, licensedPolicy, audit as any, effects as any);
      const now = Date.now();
      const day = 86400000;
      const claims: LicenseClaims = {
        version: 1, product: 'wikisavvy', edition: 'enterprise', licenseId: randomUUID(), workspaceId,
        licensee: 'Isolated acceptance fixture', seats: null, capabilities: ['wikisavvy.page-permissions'],
        issuedAt: new Date(now - 101 * day).toISOString(), notBefore: new Date(now - 100 * day).toISOString(),
        expiresAt: new Date(now + (state === 'grace' ? -1 : 1) * day).toISOString(),
      };
      await licensingService.activate(workspaceId, otherUser, issueLicense(claims, 'acceptance', pair.privateKey));
      const initial = await licensedManagement.state(actor, pageId);
      expect(initial.canCreateRestriction).toBe(true);
      const created = await licensedManagement.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      });
      const expired = issueLicense({ ...claims, expiresAt: new Date(now - 40 * day).toISOString() }, 'acceptance', pair.privateKey);
      await repository.transaction((trx) => repository.save(
        workspaceId, encryption.encrypt(expired, EncryptionPurpose.WIKISAVVY_LICENSE), otherUser, trx,
      ));
      expect((await licensingService.status(workspaceId)).status).toBe('expired');
      const maintained = await licensedManagement.set(actor, pageId, {
        revision: created.revision,
        grants: [{ type: 'user', id: userId, role: 'writer' }, { type: 'user', id: otherUser, role: 'reader' }],
      });
      const removed = await licensedManagement.remove(actor, pageId, maintained.revision);
      await expect(licensedManagement.set(actor, pageId, {
        revision: removed.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      })).rejects.toThrow(ForbiddenException);
    });
    it('returns only minimal creation entitlement and direct principal labels to managers', async () => {
      const state = await management.state(actor, pageId);
      expect(state.canCreateRestriction).toBe(true);
      expect(JSON.stringify(state)).not.toMatch(/licensee|licenseId|encryptedLicense|seats|trustConfigured/);
      licensing.status.mockResolvedValue({ status: 'expired', features: [] });
      expect((await management.state(actor, pageId)).canCreateRestriction).toBe(false);
      await restrict(pageId, [{ userId, role: 'writer' }]);
      licensing.status.mockClear();
      const existing = await management.state(actor, pageId);
      expect(existing.grants).toEqual([expect.objectContaining({
        id: userId, type: 'user', role: 'writer', name: 'writer@example.invalid',
      })]);
      expect(licensing.status).not.toHaveBeenCalled();
    });

    it('limits principal search to eligible active users and same-workspace groups', async () => {
      await db.deleteFrom('spaceMembers').where('userId', '=', otherUser).execute();
      await db.insertInto('groups').values({ id: randomUUID(), workspaceId: otherWorkspace, name: 'Foreign' }).execute();
      const principals = await management.principals(actor, pageId, '');
      expect(principals.map((principal) => principal.id).sort()).toEqual([userId, groupId].sort());
      expect(await management.principals(actor, pageId, 'Team')).toEqual([
        expect.objectContaining({ type: 'group', id: groupId, name: 'Team' }),
      ]);
    });
    it('creates a direct restriction and records its audit only after commit', async () => {
      const initial = await management.info(actor, pageId);
      expect(initial.hasDirectRestriction).toBe(false);
      expect(initial.revision).toMatch(/^[0-9a-f]{64}$/);
      audit.log.mockImplementationOnce(async () => {
        expect(await permissions.findPageAccessByPageId(pageId)).toBeDefined();
      });
      const result = await management.set(actor, pageId, {
        revision: initial.revision,
        grants: [{ type: 'user', id: userId, role: 'writer' }],
      });
      expect(result.hasDirectRestriction).toBe(true);
      expect(result.revision).not.toBe(initial.revision);
      expect(await permissions.canUserEditPage(userId, pageId, { skipCache: true })).toMatchObject({
        hasAnyRestriction: true, canAccess: true, canEdit: true,
      });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        event: 'page.restricted', resourceId: pageId,
      }));
    });

    it('rejects a stale edit rather than overwrite a newer manager change', async () => {
      const initial = await management.info(actor, pageId);
      await management.set(actor, pageId, {
        revision: initial.revision,
        grants: [{ type: 'user', id: userId, role: 'writer' }],
      });
      await expect(management.set(actor, pageId, {
        revision: initial.revision,
        grants: [{ type: 'user', id: otherUser, role: 'writer' }],
      })).rejects.toThrow(ConflictException);
    });

    it('maintains and removes an existing restriction without consulting licensing', async () => {
      await restrict(pageId, [{ userId, role: 'writer' }]);
      licensing.status.mockRejectedValue(new Error('license store unavailable'));
      const initial = await management.info(actor, pageId);
      const changed = await management.set(actor, pageId, {
        revision: initial.revision,
        grants: [
          { type: 'user', id: userId, role: 'writer' },
          { type: 'user', id: otherUser, role: 'reader' },
        ],
      });
      await management.remove(actor, pageId, changed.revision);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
      expect(licensing.status).not.toHaveBeenCalled();
      expect((await management.info(actor, pageId)).revision).not.toBe(initial.revision);
    });

    it('rejects a new empty restriction and rolls its rows and audit back', async () => {
      const initial = await management.info(actor, pageId);
      await expect(management.set(actor, pageId, {
        revision: initial.revision, grants: [],
      })).rejects.toThrow(ConflictException);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
      expect((await management.info(actor, pageId)).revision).toBe(initial.revision);
      expect(audit.log).not.toHaveBeenCalled();
      expect(effects.afterChange).not.toHaveBeenCalled();
    });

    it('never reuses an old precondition after restriction removal and recreation', async () => {
      const initial = await management.info(actor, pageId);
      const restricted = await management.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      });
      const removed = await management.remove(actor, pageId, restricted.revision);
      expect(removed.revision).not.toBe(initial.revision);
      await expect(management.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      })).rejects.toThrow(ConflictException);
    });

    it('invalidates a child precondition when its ancestor grants change', async () => {
      await restrict(pageId, [{ userId, role: 'writer' }, { userId: otherUser, role: 'reader' }]);
      await restrict(childId, [{ userId, role: 'writer' }]);
      const child = await management.info(actor, childId);
      const parent = await management.info(actor, pageId);
      await management.set(actor, pageId, {
        revision: parent.revision,
        grants: [
          { type: 'user', id: userId, role: 'writer' },
          { type: 'user', id: otherUser, role: 'writer' },
        ],
      });
      await expect(management.set(actor, childId, {
        revision: child.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      })).rejects.toThrow(ConflictException);
    });

    it('allows exactly one of two concurrent edits with the same precondition', async () => {
      const initial = await management.info(actor, pageId);
      const results = await Promise.allSettled(['reader', 'writer'].map((role) =>
        management.set(actor, pageId, {
          revision: initial.revision,
          grants: [
            { type: 'user', id: userId, role: 'writer' },
            { type: 'user', id: otherUser, role: role as 'reader' | 'writer' },
          ],
        }),
      ));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const denied = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(denied.reason).toBeInstanceOf(ConflictException);
    });

    it.each(['user', 'group'] as const)('rejects a foreign-workspace %s without persisting a grant', async (type) => {
      const foreignId = randomUUID();
      if (type === 'user') {
        await db.insertInto('users').values({
          id: foreignId, workspaceId: otherWorkspace, email: 'foreign@example.invalid',
        }).execute();
      } else {
        await db.insertInto('groups').values({ id: foreignId, workspaceId: otherWorkspace }).execute();
      }
      const initial = await management.info(actor, pageId);
      await expect(management.set(actor, pageId, {
        revision: initial.revision,
        grants: [{ type: 'user', id: userId, role: 'writer' }, { type, id: foreignId, role: 'reader' }],
      })).rejects.toThrow(NotFoundException);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rejects a user without actual space membership', async () => {
      await db.deleteFrom('spaceMembers').where('userId', '=', otherUser).execute();
      const initial = await management.info(actor, pageId);
      await expect(management.set(actor, pageId, {
        revision: initial.revision,
        grants: [
          { type: 'user', id: userId, role: 'writer' },
          { type: 'user', id: otherUser, role: 'reader' },
        ],
      })).rejects.toThrow(NotFoundException);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
    });

    it('rejects duplicated principals and unsupported roles before writing', async () => {
      const initial = await management.info(actor, pageId);
      for (const grants of [
        [{ type: 'user', id: userId, role: 'admin' }],
        [{ type: 'user', id: userId, role: 'writer' }, { type: 'user', id: userId.toUpperCase(), role: 'reader' }],
      ]) {
        await expect(management.set(actor, pageId, {
          revision: initial.revision, grants: grants as any,
        })).rejects.toThrow(BadRequestException);
      }
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
    });

    it.each([false, true])('does not count an empty or disabled-member group as the last writer (disabled=%s)', async (disabled) => {
      if (disabled) {
        await db.insertInto('groupUsers').values({ userId: otherUser, groupId }).execute();
        await db.updateTable('users').set({ deactivatedAt: new Date() }).where('id', '=', otherUser).execute();
      }
      const initial = await management.info(actor, pageId);
      await expect(management.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'group', id: groupId, role: 'writer' }],
      })).rejects.toThrow(ConflictException);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
    });

    it('accepts a group whose active member can actually edit the resulting restriction', async () => {
      await db.insertInto('groupUsers').values({ userId, groupId }).execute();
      const initial = await management.info(actor, pageId);
      await expect(management.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'group', id: groupId, role: 'writer' }],
      })).resolves.toMatchObject({ hasDirectRestriction: true });
    });

    it('protects a hidden restricted descendant without revealing its grants', async () => {
      await restrict(childId, [{ userId: otherUser, role: 'writer' }]);
      const initial = await management.info(actor, pageId);
      const failure = management.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      });
      await expect(failure).rejects.toThrow(ConflictException);
      await expect(failure).rejects.not.toThrow(childId);
      await expect(failure).rejects.not.toThrow(otherUser);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('cannot remove the direct restriction when the inherited result has no active writer', async () => {
      await restrict(pageId, [{ userId, role: 'reader' }]);
      await restrict(childId, [{ userId, role: 'writer' }]);
      const initial = await management.info(actor, childId);
      await expect(management.remove(actor, childId, initial.revision)).rejects.toThrow(ConflictException);
      expect(await permissions.findPageAccessByPageId(childId)).toBeDefined();
    });

    it('cannot remove the direct restriction when the unrestricted space has no active writer', async () => {
      await db.updateTable('spaceMembers').set({ role: 'reader' }).execute();
      await restrict(pageId, [{ userId, role: 'writer' }]);
      const initial = await management.info(actor, pageId);
      await expect(management.remove(actor, pageId, initial.revision)).rejects.toThrow(ConflictException);
      expect(await permissions.findPageAccessByPageId(pageId)).toBeDefined();
    });

    it('audits added, role-changed and removed principals accurately after commit', async () => {
      await restrict(pageId, [{ userId, role: 'writer' }]);
      let snapshot = await management.info(actor, pageId);
      for (const role of ['reader', 'writer'] as const) {
        snapshot = await management.set(actor, pageId, {
          revision: snapshot.revision,
          grants: [
            { type: 'user', id: userId, role: 'writer' },
            { type: 'user', id: otherUser, role },
          ],
        });
      }
      await management.set(actor, pageId, {
        revision: snapshot.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      });
      expect(audit.log.mock.calls.map(([payload]) => payload.event)).toEqual([
        'page.permission_added', 'page.permission_role_changed', 'page.permission_removed',
      ]);
      for (const [payload] of audit.log.mock.calls) {
        expect(payload.metadata.userId).toBe(otherUser);
        expect(JSON.stringify(payload)).not.toContain('example.invalid');
      }
    });

    it('does not audit inherited restriction removal as unrestricted access', async () => {
      await restrict(pageId, [{ userId, role: 'writer' }]);
      await restrict(childId, [{ userId, role: 'writer' }]);
      const initial = await management.info(actor, childId);
      const result = await management.remove(actor, childId, initial.revision);
      expect(result).toMatchObject({ hasDirectRestriction: false, inheritedPageId: pageId });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        event: 'page.restriction_removed', metadata: expect.objectContaining({ hasRestriction: true }),
      }));
    });

    it('keeps a committed restriction when the best-effort audit provider rejects', async () => {
      audit.log.mockRejectedValue(new Error('synthetic-private-audit-error'));
      const initial = await management.info(actor, pageId);
      await expect(management.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      })).resolves.toMatchObject({ hasDirectRestriction: true });
      expect(await permissions.findPageAccessByPageId(pageId)).toBeDefined();
    });

    it('runs notification effects only after commit and does not let their failure undo permissions', async () => {
      const initial = await management.info(actor, pageId);
      effects.afterChange.mockImplementationOnce(async (id: string) => {
        expect(await permissions.findPageAccessByPageId(id)).toBeDefined();
        throw new Error('synthetic-notification-failure');
      });
      await expect(management.set(actor, pageId, {
        revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
      })).resolves.toMatchObject({ hasDirectRestriction: true });
      expect(effects.afterChange).toHaveBeenCalledWith(pageId, spaceId);
    });

    it('reauthorizes a queued manager after group membership is revoked before the workspace lock', async () => {
      await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
      await db.insertInto('spaceMembers').values({ groupId, spaceId, role: 'writer' }).execute();
      await db.insertInto('groupUsers').values({ groupId, userId }).execute();
      const initial = await management.info(actor, pageId);
      let release: () => void;
      let ready: () => void;
      let attempting: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const attempted = new Promise<void>((resolve) => { attempting = resolve; });
      const first = db.transaction().execute(async (trx) => {
        await trx.selectFrom('workspaces').select('id').where('id', '=', workspaceId).forUpdate().execute();
        await trx.deleteFrom('groupUsers').where('userId', '=', userId).execute();
        ready();
        await held;
      });
      await locked;
      const original = managementRepo.lockWorkspace.bind(managementRepo);
      const spy = jest.spyOn(managementRepo, 'lockWorkspace').mockImplementation((id, trx) => {
        const pending = original(id, trx);
        attempting();
        return pending;
      });
      try {
        const changing = management.set(actor, pageId, {
          revision: initial.revision, grants: [{ type: 'user', id: userId, role: 'writer' }],
        });
        const denied = expect(changing).rejects.toThrow(ForbiddenException);
        await attempted;
        release();
        await first;
        await denied;
        expect(await permissions.findPageAccessByPageId(pageId)).toBeUndefined();
        expect(audit.log).not.toHaveBeenCalled();
      } finally {
        release();
        await first;
        spy.mockRestore();
      }
    });

    it.each(['group', 'account', 'space', 'archive'])(
      'serializes a concurrent %s revocation behind the in-flight authorization and then rejects new management',
      async (kind) => {
        await db.deleteFrom('spaceMembers').where('userId', '=', userId).execute();
        await db.insertInto('spaceMembers').values({ groupId, spaceId, role: 'writer' }).execute();
        await db.insertInto('groupUsers').values({ groupId, userId }).execute();
        const initial = await management.info(actor, pageId);
        let release: () => void;
        let ready: () => void;
        let revoking: () => void;
        let revokerPid: number;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const locked = new Promise<void>((resolve) => { ready = resolve; });
        const revokeStarted = new Promise<void>((resolve) => { revoking = resolve; });
        const original = managementRepo.replace.bind(managementRepo);
        const spy = jest.spyOn(managementRepo, 'replace').mockImplementation(async (...args) => {
          ready();
          await held;
          return original(...args);
        });
        const changing = management.set(actor, pageId, {
          revision: initial.revision,
          grants: [
            { type: 'user', id: userId, role: 'writer' },
            { type: 'user', id: otherUser, role: 'writer' },
          ],
        });
        let revoke: Promise<unknown>;
        try {
          await Promise.race([
            locked,
            changing.then(() => { throw new Error('Mutation completed without the expected lock checkpoint'); }),
          ]);
          revoke = db.transaction().execute(async (trx) => {
            revokerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0].pid;
            const query = kind === 'group'
              ? trx.deleteFrom('groupUsers').where('userId', '=', userId)
              : kind === 'account'
                ? trx.updateTable('users').set({ deactivatedAt: new Date() }).where('id', '=', userId)
                : kind === 'space'
                  ? trx.deleteFrom('spaceMembers').where('spaceId', '=', spaceId).where('groupId', '=', groupId)
                  : trx.updateTable('spaces').set({ archivedAt: new Date() }).where('id', '=', spaceId);
            const pending = query.execute();
            revoking();
            await pending;
          });
          await revokeStarted;
          const deadline = Date.now() + 2000;
          let blockers: number[] = [];
          while (Date.now() < deadline) {
            blockers = (await sql<{ blockers: number[] }>`SELECT pg_blocking_pids(${revokerPid}) AS blockers`
              .execute(db)).rows[0].blockers;
            if (blockers.length) break;
            await delay(10);
          }
          expect(blockers.length).toBeGreaterThan(0);
          release();
          await changing;
          await revoke;
          await expect(manage()).rejects.toThrow(ForbiddenException);
        } finally {
          release();
          await Promise.allSettled([changing, revoke]);
          spy.mockRestore();
        }
      },
    );
  });
});
