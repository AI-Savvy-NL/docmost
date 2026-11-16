import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CamelCasePlugin, Kysely } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { ClsService } from 'nestjs-cls';
import { up as uuidMigration } from '../../database/migrations/20240324T085400-uuid_v7_fn';
import { up as auditMigration } from '../../database/migrations/20260228T223532-audit';
import { up as siemMigration } from '../../database/migrations/20260902T121326-siem-destinations';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { prepareAuditRecord } from './audit-record';
import { WikisavvyAuditRepo } from './audit.repo';
import { WikisavvyAuditService } from './audit.service';

const url = process.env.WIKISAVVY_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Independent audit with isolated PostgreSQL', () => {
  let db: Kysely<any>;
  let repository: WikisavvyAuditRepo;
  let service: WikisavvyAuditService;
  const workspaceId = randomUUID();
  const otherWorkspace = randomUUID();
  const actorId = randomUUID();
  const context = { workspaceId, actorId, actorType: 'user' as const };
  const payload = { event: AuditEvent.USER_LOGIN, resourceType: AuditResource.USER, resourceId: actorId };

  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/wikisavvy_audit_test') {
      throw new Error('Refusing a non-local audit test database');
    }
    db = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url, { max: 5, onnotice: () => {} }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    await db.schema.createTable('workspaces').addColumn('id', 'uuid', (c) => c.primaryKey()).execute();
    await db.schema.createTable('users').addColumn('id', 'uuid', (c) => c.primaryKey()).execute();
    await uuidMigration(db);
    await auditMigration(db);
    await siemMigration(db);
    await db.insertInto('workspaces').values([{ id: workspaceId }, { id: otherWorkspace }]).execute();
    repository = new WikisavvyAuditRepo(db as any);
  });
  beforeEach(async () => {
    await db.deleteFrom('audit').execute();
    service = new WikisavvyAuditService(repository, new ClsService(new AsyncLocalStorage()));
  });
  afterAll(async () => {
    if (db) await db.destroy();
  });

  it('persists only sanitized fields using real defaults', async () => {
    await service.logWithContext({
      ...payload,
      metadata: { source: 'password', password: 'synthetic-sensitive-details' },
      changes: { after: { role: 'member', name: 'synthetic-sensitive-details' } },
    }, { ...context, userAgent: 'synthetic-sensitive-details', ipAddress: '192.0.2.1' });
    const row = await db.selectFrom('audit').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      workspaceId, actorId, actorType: 'user', event: payload.event,
      metadata: { source: 'password' }, changes: { after: { role: 'member' } },
      userAgent: null, ipAddress: '192.0.2.1',
    });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(row)).not.toContain('synthetic-sensitive-details');
    expect((await service.list(workspaceId, { limit: 50 })).captureStatus.recorded).toBe(1);
  });
  it('isolates workspace records even with a cursor taken from another workspace', async () => {
    const own = prepareAuditRecord(payload, context);
    const other = prepareAuditRecord(payload, { ...context, workspaceId: otherWorkspace });
    await repository.insert({ ...own, id: '11111111-1111-4111-8111-111111111111' });
    await repository.insert({ ...other, id: '22222222-2222-4222-8222-222222222222' });
    await repository.insert({ ...other, id: '33333333-3333-4333-8333-333333333333' });
    const foreign = await repository.list(otherWorkspace, { limit: 1 });
    const page = await repository.list(workspaceId, { limit: 50, cursor: foreign.meta.nextCursor });
    expect(page.items.map((row) => row.id)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect((await repository.list(workspaceId, { limit: 50 })).items).toHaveLength(1);
  });
  it('paginates deterministically without duplicates, including equal timestamps', async () => {
    const createdAt = new Date('2026-11-16T00:00:00Z');
    const ids = [1, 2, 3, 4, 5].map((value) => `11111111-1111-4111-8111-${String(value).padStart(12, '0')}`);
    for (const id of ids) await repository.insert({ ...prepareAuditRecord(payload, context), id, createdAt });
    const first = await repository.list(workspaceId, { limit: 2 });
    const second = await repository.list(workspaceId, { limit: 2, cursor: first.meta.nextCursor });
    const third = await repository.list(workspaceId, { limit: 2, cursor: second.meta.nextCursor });
    expect([...first.items, ...second.items, ...third.items].map((row) => row.id)).toEqual([...ids].reverse());
    expect(first.meta.hasNextPage).toBe(true);
    expect(third.meta.hasNextPage).toBe(false);
    const back = await repository.list(workspaceId, { limit: 2, beforeCursor: second.meta.prevCursor });
    expect(back.items.map((row) => row.id)).toEqual(first.items.map((row) => row.id));
  });
  it('omits historical JSON, headers and unknown labels at the API projection', async () => {
    await repository.insert({
      ...prepareAuditRecord(payload, context),
      event: 'synthetic-sensitive-details', actorType: 'synthetic-sensitive-details',
      resourceType: 'synthetic-sensitive-details', metadata: { arbitrary: 'synthetic-sensitive-details' },
      changes: { after: { password: 'synthetic-sensitive-details' } },
      userAgent: 'synthetic-sensitive-details',
    });
    const storedProjection = (await repository.list(workspaceId, { limit: 50 })).items[0];
    expect(storedProjection).not.toHaveProperty('metadata');
    expect(storedProjection).not.toHaveProperty('userAgent');
    const page = await service.list(workspaceId, { limit: 50 });
    expect(page.items[0]).toMatchObject({ event: 'unknown', actorType: 'unknown', resourceType: 'unknown' });
    expect(JSON.stringify(page)).not.toContain('synthetic-sensitive-details');
  });
  it.each([0, 101, 1.5])('rejects an unbounded page size %s', async (limit) => {
    await expect(service.list(workspaceId, { limit })).rejects.toMatchObject({ status: 400 });
  });
  it.each(['malformed', Buffer.from('id=not-a-uuid').toString('base64url'), 'x'.repeat(513)])(
    'rejects an invalid cursor without database diagnostics',
    async (cursor) => {
      await expect(service.list(workspaceId, { limit: 50, cursor })).rejects.toMatchObject({ status: 400 });
    },
  );
  it('rejects conflicting cursors and invalid workspace identifiers', async () => {
    await expect(service.list(workspaceId, { limit: 50, cursor: 'x', beforeCursor: 'y' })).rejects.toMatchObject({ status: 400 });
    await expect(service.list('invalid', { limit: 50 })).rejects.toMatchObject({ status: 400 });
  });
  it('does not write malformed records', async () => {
    await service.logWithContext({ ...payload, event: 'invalid' } as any, context);
    expect(await db.selectFrom('audit').select('id').execute()).toEqual([]);
    expect((await service.list(workspaceId, { limit: 50 })).captureStatus.rejected).toBe(1);
  });
});
