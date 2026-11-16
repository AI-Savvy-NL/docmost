import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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

const url = process.env.WIKISAVVY_PERMISSION_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Page permission policy with isolated PostgreSQL', () => {
  let db: Kysely<any>;
  let pages: PageRepo;
  let permissions: PagePermissionRepo;
  let spaces: SpaceMemberRepo;
  let policy: WikisavvyPagePermissionPolicy;
  let licensing: any;
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
  });
  beforeEach(async () => {
    for (const table of ['pagePermissions', 'pageAccess', 'spaceMembers', 'groupUsers', 'pages', 'groups', 'spaces', 'users', 'workspaces']) {
      await db.deleteFrom(table).execute();
    }
    await db.insertInto('workspaces').values([{ id: workspaceId }, { id: otherWorkspace }]).execute();
    await db.insertInto('users').values([
      { id: userId, workspaceId, role: 'member', email: 'writer@example.invalid' },
      { id: otherUser, workspaceId, role: 'owner', email: 'other@example.invalid' },
    ]).execute();
    await db.insertInto('spaces').values({ id: spaceId, workspaceId }).execute();
    await db.insertInto('groups').values({ id: groupId, workspaceId }).execute();
    await db.insertInto('spaceMembers').values([
      { userId, spaceId, role: 'writer' }, { userId: otherUser, spaceId, role: 'writer' },
    ]).execute();
    await db.insertInto('pages').values([
      { id: pageId, spaceId, workspaceId, slugId: 'parent' },
      { id: childId, spaceId, workspaceId, parentPageId: pageId, slugId: 'child' },
    ]).execute();
    jest.clearAllMocks();
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
  it('preserves ordinary cached callers and their explicit uncached override', async () => {
    await restrict(pageId, []);
    await db.updateTable('spaceMembers').set({ role: 'reader' }).where('userId', '=', userId).execute();
    expect(await permissions.canUserEditPage(userId, pageId)).toEqual({
      hasAnyRestriction: false, canAccess: true, canEdit: true,
    });
    expect(await permissions.canUserEditPage(userId, pageId, { skipCache: true })).toEqual({
      hasAnyRestriction: true, canAccess: false, canEdit: false,
    });
    expect(await spaces.getUserSpaceRoles(userId, spaceId)).toEqual([{ userId, role: 'writer' }]);
    expect(await spaces.getUserSpaceRoles(userId, spaceId, { skipCache: true })).toEqual([{ userId, role: 'reader' }]);
    expect(permissionCache.get).toHaveBeenCalledTimes(1);
    expect(spaceCache.get).toHaveBeenCalledTimes(1);
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
});
