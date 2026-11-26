import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { TemplatePublicationPolicy } from './template-publication-policy';

const url = process.env.WIKISAVVY_TEMPLATE_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Template source publication with isolated PostgreSQL', () => {
  let db: Kysely<any>;
  let policy: TemplatePublicationPolicy;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const memberId = randomUUID();
  const adminId = randomUUID();
  const ownerId = randomUUID();
  const otherUserId = randomUUID();
  const spaceId = randomUUID();
  const pageId = randomUUID();
  const parentId = randomUUID();
  const groupId = randomUUID();
  const actor = { id: memberId, workspaceId };
  const publish = (who = actor, confirmed = false, id = pageId) =>
    db
      .transaction()
      .execute((trx) =>
        policy.assertCanPublish(who, id, confirmed, trx as any),
      );

  async function restrict(id = pageId, grants = [memberId, adminId, ownerId]) {
    const accessId = randomUUID();
    await db
      .insertInto('pageAccess')
      .values({
        id: accessId,
        pageId: id,
        workspaceId,
        spaceId,
      })
      .execute();
    if (grants.length) {
      await db
        .insertInto('pagePermissions')
        .values(
          grants.map((userId) => ({
            pageAccessId: accessId,
            userId,
            role: 'reader',
          })),
        )
        .execute();
    }
  }

  beforeAll(async () => {
    const parsed = new URL(url);
    if (
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/wikisavvy_template_test'
    ) {
      throw new Error('Refusing a non-local template test database');
    }
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 3, onnotice: () => {} }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    await db.schema
      .createTable('users')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('workspaceId', 'uuid')
      .addColumn('role', 'varchar')
      .addColumn('deletedAt', 'timestamptz')
      .addColumn('deactivatedAt', 'timestamptz')
      .execute();
    await db.schema
      .createTable('spaces')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('workspaceId', 'uuid')
      .addColumn('visibility', 'varchar')
      .addColumn('isPersonal', 'boolean')
      .addColumn('deletedAt', 'timestamptz')
      .addColumn('archivedAt', 'timestamptz')
      .execute();
    await db.schema
      .createTable('pages')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('workspaceId', 'uuid')
      .addColumn('spaceId', 'uuid')
      .addColumn('parentPageId', 'uuid')
      .addColumn('deletedAt', 'timestamptz')
      .addColumn('title', 'varchar')
      .addColumn('icon', 'varchar')
      .addColumn('content', 'jsonb')
      .addColumn('textContent', 'text')
      .execute();
    await db.schema
      .createTable('groups')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('workspaceId', 'uuid')
      .addColumn('deletedAt', 'timestamptz')
      .execute();
    await db.schema
      .createTable('groupUsers')
      .addColumn('userId', 'uuid')
      .addColumn('groupId', 'uuid')
      .execute();
    await db.schema
      .createTable('spaceMembers')
      .addColumn('spaceId', 'uuid')
      .addColumn('userId', 'uuid')
      .addColumn('groupId', 'uuid')
      .addColumn('role', 'varchar')
      .addColumn('deletedAt', 'timestamptz')
      .execute();
    await db.schema
      .createTable('pageAccess')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('pageId', 'uuid')
      .addColumn('workspaceId', 'uuid')
      .addColumn('spaceId', 'uuid')
      .execute();
    await db.schema
      .createTable('pagePermissions')
      .addColumn('pageAccessId', 'uuid')
      .addColumn('userId', 'uuid')
      .addColumn('groupId', 'uuid')
      .addColumn('role', 'varchar')
      .execute();
    policy = new TemplatePublicationPolicy();
  });

  afterAll(async () => {
    await db?.destroy();
  });

  beforeEach(async () => {
    for (const table of [
      'pagePermissions',
      'pageAccess',
      'spaceMembers',
      'groupUsers',
      'groups',
      'pages',
      'spaces',
      'users',
    ]) {
      await db.deleteFrom(table).execute();
    }
    await db
      .insertInto('users')
      .values([
        { id: memberId, workspaceId, role: 'member' },
        { id: adminId, workspaceId, role: 'admin' },
        { id: ownerId, workspaceId, role: 'owner' },
        { id: otherUserId, workspaceId: otherWorkspaceId, role: 'admin' },
      ])
      .execute();
    await db
      .insertInto('spaces')
      .values({
        id: spaceId,
        workspaceId,
        visibility: 'open',
        isPersonal: false,
      })
      .execute();
    await db
      .insertInto('pages')
      .values({
        id: pageId,
        workspaceId,
        spaceId,
        title: 'Snapshot source',
        content: { type: 'doc', content: [{ type: 'paragraph' }] },
        textContent: 'Snapshot source',
      })
      .execute();
    await db
      .insertInto('spaceMembers')
      .values(
        [memberId, adminId, ownerId].map((userId) => ({
          spaceId,
          userId,
          role: 'reader',
        })),
      )
      .execute();
  });

  it('allows an ordinary member to snapshot a workspace-readable page', async () => {
    const source = await publish();
    expect(source).toEqual({
      id: pageId,
      workspaceId,
      spaceId,
      title: 'Snapshot source',
      icon: null,
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      textContent: 'Snapshot source',
    });
  });

  it('does not return a live link to the database content', async () => {
    const source = await publish();
    await db.deleteFrom('pages').where('id', '=', pageId).execute();
    expect(source.content).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });

  it.each([false, true])(
    'refuses restricted-page publication by a member (confirmation=%s)',
    async (confirmed) => {
      await restrict();
      await expect(publish(actor, confirmed)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    },
  );

  it.each([adminId, ownerId])(
    'requires explicit confirmation from an elevated actor %s',
    async (id) => {
      await restrict();
      await expect(publish({ id, workspaceId })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(publish({ id, workspaceId }, true)).resolves.toHaveProperty(
        'id',
        pageId,
      );
    },
  );

  it('does not grant source access merely because the actor is an admin', async () => {
    await restrict(pageId, [memberId]);
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('checks inherited restrictions even if the leaf has no restriction', async () => {
    await db
      .insertInto('pages')
      .values({ id: parentId, workspaceId, spaceId })
      .execute();
    await db
      .updateTable('pages')
      .set({ parentPageId: parentId })
      .where('id', '=', pageId)
      .execute();
    await restrict(parentId);
    await expect(publish(actor, true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).resolves.toHaveProperty('id', pageId);
  });

  it('requires access through every restricted ancestor', async () => {
    await db
      .insertInto('pages')
      .values({ id: parentId, workspaceId, spaceId })
      .execute();
    await db
      .updateTable('pages')
      .set({ parentPageId: parentId })
      .where('id', '=', pageId)
      .execute();
    await restrict(parentId, [memberId]);
    await restrict(pageId);
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('treats a private space as restricted even with no page restrictions', async () => {
    await db.updateTable('spaces').set({ visibility: 'private' }).execute();
    await expect(publish()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).resolves.toHaveProperty('id', pageId);
  });

  it('does not mistake an open space for workspace-wide read access', async () => {
    await db.deleteFrom('spaceMembers').where('userId', '=', ownerId).execute();
    await expect(publish()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts live same-workspace group membership for the source audience', async () => {
    await db.deleteFrom('spaceMembers').execute();
    await db
      .insertInto('groups')
      .values({ id: groupId, workspaceId })
      .execute();
    await db
      .insertInto('groupUsers')
      .values(
        [memberId, adminId, ownerId].map((userId) => ({ userId, groupId })),
      )
      .execute();
    await db
      .insertInto('spaceMembers')
      .values({ spaceId, groupId, role: 'reader' })
      .execute();
    await expect(publish()).resolves.toHaveProperty('id', pageId);
  });

  it('rejects revoked group read access immediately', async () => {
    await db
      .deleteFrom('spaceMembers')
      .where('userId', '=', memberId)
      .execute();
    await db
      .insertInto('groups')
      .values({ id: groupId, workspaceId })
      .execute();
    await db
      .insertInto('groupUsers')
      .values({ userId: memberId, groupId })
      .execute();
    await db
      .insertInto('spaceMembers')
      .values({ spaceId, groupId, role: 'reader' })
      .execute();
    await expect(publish()).resolves.toHaveProperty('id', pageId);
    await db.deleteFrom('groupUsers').where('userId', '=', memberId).execute();
    await expect(publish()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts group grants on restricted ancestors for a confirmed admin', async () => {
    await restrict(pageId, []);
    const access = await db
      .selectFrom('pageAccess')
      .select('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('groups')
      .values({ id: groupId, workspaceId })
      .execute();
    await db
      .insertInto('groupUsers')
      .values({ userId: adminId, groupId })
      .execute();
    await db
      .insertInto('pagePermissions')
      .values({ pageAccessId: access.id, groupId, role: 'reader' })
      .execute();
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).resolves.toHaveProperty('id', pageId);
    await db.updateTable('groups').set({ deletedAt: new Date() }).execute();
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not count a foreign-workspace group as source read access', async () => {
    await db
      .deleteFrom('spaceMembers')
      .where('userId', '=', memberId)
      .execute();
    await db
      .insertInto('groups')
      .values({ id: groupId, workspaceId: otherWorkspaceId })
      .execute();
    await db
      .insertInto('groupUsers')
      .values({ userId: memberId, groupId })
      .execute();
    await db
      .insertInto('spaceMembers')
      .values({ spaceId, groupId, role: 'reader' })
      .execute();
    await expect(publish()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let a forged caller role replace the persisted workspace role', async () => {
    await restrict();
    await expect(
      publish({ ...actor, role: 'admin' } as any, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('observes an admin role downgrade without waiting for token expiry', async () => {
    await restrict();
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).resolves.toHaveProperty('id', pageId);
    await db
      .updateTable('users')
      .set({ role: 'member' })
      .where('id', '=', adminId)
      .execute();
    await expect(
      publish({ id: adminId, workspaceId }, true),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['deletedAt', 'deactivatedAt'])(
    'rejects an actor with %s set',
    async (field) => {
      await db
        .updateTable('users')
        .set({ [field]: new Date() })
        .where('id', '=', memberId)
        .execute();
      await expect(publish()).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('does not leak a foreign-workspace source to a confirmed foreign admin', async () => {
    await expect(
      publish({ id: otherUserId, workspaceId: otherWorkspaceId }, true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a caller claiming someone else’s workspace', async () => {
    await expect(
      publish({ id: otherUserId, workspaceId }, true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a deleted source', async () => {
    await db.updateTable('pages').set({ deletedAt: new Date() }).execute();
    await expect(publish()).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['deletedAt', 'archivedAt'])(
    'rejects a source space with %s set',
    async (field) => {
      await db
        .updateTable('spaces')
        .set({ [field]: new Date() })
        .execute();
      await expect(publish()).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('does not count deleted space membership as read access', async () => {
    await db
      .updateTable('spaceMembers')
      .set({ deletedAt: new Date() })
      .where('userId', '=', memberId)
      .execute();
    await expect(publish()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not require inactive workspace users to retain space membership', async () => {
    await db.deleteFrom('spaceMembers').where('userId', '=', ownerId).execute();
    await db
      .updateTable('users')
      .set({ deactivatedAt: new Date() })
      .where('id', '=', ownerId)
      .execute();
    await expect(publish()).resolves.toHaveProperty('id', pageId);
  });

  it('does not treat personal spaces as workspace-readable', async () => {
    await db.updateTable('spaces').set({ isPersonal: true }).execute();
    await expect(publish()).rejects.toBeInstanceOf(ForbiddenException);
  });
});
