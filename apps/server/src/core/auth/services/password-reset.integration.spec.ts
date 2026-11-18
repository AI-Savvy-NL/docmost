import { randomBytes, randomUUID } from 'node:crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { AuthService } from './auth.service';
import { UserRepo } from '../../../database/repos/user/user.repo';
import { UserTokenRepo } from '../../../database/repos/user-token/user-token.repo';
import { UserSessionRepo } from '../../../database/repos/session/user-session.repo';
import { hashPassword } from '../../../common/helpers';
import {
  BadRequestException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { ThrottlerGuard } from '@nestjs/throttler';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthController } from '../auth.controller';
import { SessionService } from '../../session/session.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { AUDIT_SERVICE } from '../../../integrations/audit/audit.service';
import { SetupGuard } from '../guards/setup.guard';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { comparePasswordHash } from '../../../common/helpers';

const url = process.env.WIKISAVVY_RECOVERY_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Password recovery with isolated PostgreSQL', () => {
  let root: Kysely<any>;
  let db: Kysely<any>;
  let service: AuthService;
  let users: UserRepo;
  let tokens: UserTokenRepo;
  let sessions: UserSessionRepo;
  let initialHash: string;
  let app: NestFastifyApplication;
  const schema = 'recovery_test_' + randomBytes(8).toString('hex');
  const workspace = { id: randomUUID(), enforceSso: false, enforceMfa: false };
  const foreignWorkspace = randomUUID();
  const userId = randomUUID();
  const foreignUser = randomUUID();
  const token = 'synthetic-' + randomUUID();
  const newPassword = 'synthetic-new-password';
  const minted = jest.fn();
  const disconnect = jest.fn();
  const audit = { setActorId: jest.fn(), log: jest.fn() };
  const mail = { sendToQueue: jest.fn() };
  const cloud = jest.fn(() => false);

  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/wikisavvy_recovery_test'
    ) {
      throw new Error('Refusing a non-local recovery test database');
    }
    root = new Kysely({
      dialect: new PostgresJSDialect({
        postgres: postgres(url!, { max: 8, onnotice: () => {} }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    await root.schema.createSchema(schema).execute();
    db = root.withSchema(schema);
    await db.schema
      .createTable('workspaces')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .execute();
    let userTable = db.schema
      .createTable('users')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('workspaceId', 'uuid', (c) =>
        c.notNull().references('workspaces.id'),
      )
      .addColumn('password', 'text', (c) => c.notNull())
      .addColumn('hasGeneratedPassword', 'boolean', (c) =>
        c.notNull().defaultTo(true),
      )
      .addColumn('settings', 'jsonb');
    for (const name of [
      'email',
      'name',
      'avatarUrl',
      'role',
      'locale',
      'timezone',
    ]) {
      userTable = userTable.addColumn(name, 'text');
    }
    for (const name of [
      'emailVerifiedAt',
      'lastLoginAt',
      'deactivatedAt',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ]) {
      userTable = userTable.addColumn(name, 'timestamptz');
    }
    await userTable.execute();
    await db.schema
      .createTable('userTokens')
      .addColumn('id', 'uuid', (c) =>
        c.primaryKey().defaultTo(sql`gen_random_uuid()`),
      )
      .addColumn('token', 'text', (c) => c.notNull())
      .addColumn('type', 'text', (c) => c.notNull())
      .addColumn('userId', 'uuid', (c) => c.notNull().references('users.id'))
      .addColumn('workspaceId', 'uuid', (c) => c.references('workspaces.id'))
      .addColumn('expiresAt', 'timestamptz')
      .addColumn('usedAt', 'timestamptz')
      .addColumn('createdAt', 'timestamptz', (c) => c.defaultTo(sql`now()`))
      .execute();
    await db.schema
      .createTable('userSessions')
      .addColumn('id', 'uuid', (c) =>
        c.primaryKey().defaultTo(sql`gen_random_uuid()`),
      )
      .addColumn('userId', 'uuid', (c) => c.notNull().references('users.id'))
      .addColumn('workspaceId', 'uuid', (c) =>
        c.notNull().references('workspaces.id'),
      )
      .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
      .addColumn('revokedAt', 'timestamptz')
      .execute();
    users = new UserRepo(db as any);
    tokens = new UserTokenRepo(db as any);
    sessions = new UserSessionRepo(db as any);
    service = new AuthService(
      {} as any,
      {} as any,
      { createSessionAndToken: minted } as any,
      sessions,
      users,
      tokens,
      mail as any,
      { getUrl: () => 'https://recovery.example.invalid' } as any,
      { isCloud: cloud } as any,
      { emitAsync: jest.fn() } as any,
      db as any,
      audit as any,
      { disconnectUser: disconnect } as any,
    );
    initialHash = await hashPassword('synthetic-original-password');
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: service },
        { provide: SessionService, useValue: {} },
        {
          provide: EnvironmentService,
          useValue: {
            isCloud: cloud,
            isHttps: () => true,
            getCookieExpiresIn: () => new Date(Date.now() + 60000),
          },
        },
        { provide: AUDIT_SERVICE, useValue: audit },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SetupGuard)
      .useValue({ canActivate: () => false })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => false })
      .compile();
    const adapter = new FastifyAdapter();
    adapter.getInstance().addHook('onRequest', (req, _reply, done) => {
      (req.raw as any).workspace = workspace;
      done();
    });
    app = module.createNestApplication<NestFastifyApplication>(adapter, {
      logger: false,
    });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.register(cookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    cloud.mockReturnValue(false);
    workspace.enforceSso = false;
    workspace.enforceMfa = false;
    await db.deleteFrom('userTokens').execute();
    await db.deleteFrom('userSessions').execute();
    await db.deleteFrom('users').execute();
    await db.deleteFrom('workspaces').execute();
    await db
      .insertInto('workspaces')
      .values([{ id: workspace.id }, { id: foreignWorkspace }])
      .execute();
    await db
      .insertInto('users')
      .values([
        {
          id: userId,
          workspaceId: workspace.id,
          password: initialHash,
          email: 'reset@example.invalid',
          name: 'Reset fixture',
        },
        {
          id: foreignUser,
          workspaceId: foreignWorkspace,
          password: initialHash,
          email: 'foreign@example.invalid',
          name: 'Foreign fixture',
        },
      ])
      .execute();
    await tokens.insertUserToken({
      token,
      userId,
      workspaceId: workspace.id,
      type: 'forgot-password',
      expiresAt: new Date(Date.now() + 60000),
    });
    await db
      .insertInto('userSessions')
      .values([
        {
          userId,
          workspaceId: workspace.id,
          expiresAt: new Date(Date.now() + 60000),
        },
        {
          userId: foreignUser,
          workspaceId: foreignWorkspace,
          expiresAt: new Date(Date.now() + 60000),
        },
      ])
      .execute();
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    if (root) {
      await root.schema.dropSchema(schema).cascade().execute();
      await root.destroy();
    }
  });

  it.each(Array.from({ length: 10 }, (_, i) => i + 1))(
    'allows one concurrent reset of the same token, run %i',
    async () => {
      const find = tokens.findById.bind(tokens);
      let observed = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(tokens, 'findById').mockImplementation(async (...args) => {
        const result = await find(...args);
        if (++observed === 2) release();
        await barrier;
        return result;
      });
      const reset = () =>
        service.passwordReset({ token, newPassword }, workspace as any);
      const results = await Promise.allSettled([reset(), reset()]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(minted).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rolls back credentials if session invalidation fails, cloud=%s',
    async (isCloud) => {
      cloud.mockReturnValue(isCloud);
      const remove = sessions.deleteByUserId.bind(sessions);
      jest
        .spyOn(sessions, 'deleteByUserId')
        .mockImplementation(async (...args) => {
          await remove(...args);
          throw new Error('synthetic-session-storage-failure');
        });
      await expect(
        service.passwordReset({ token, newPassword }, workspace as any),
      ).rejects.toThrow('synthetic-session-storage-failure');
      const user = await db
        .selectFrom('users')
        .select('password')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(user.password === initialHash).toBe(true);
      expect(
        (await users.findById(userId, workspace.id)).emailVerifiedAt,
      ).toBeNull();
      expect(await tokens.findById(token, workspace.id)).toBeDefined();
      expect(
        await db
          .selectFrom('userSessions')
          .select('id')
          .where('userId', '=', userId)
          .execute(),
      ).toHaveLength(1);
      expect(disconnect).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it('resets the password while preserving other purposes and foreign accounts', async () => {
    await db
      .insertInto('userSessions')
      .values({
        userId,
        workspaceId: workspace.id,
        expiresAt: new Date(Date.now() + 60000),
      })
      .execute();
    await tokens.insertUserToken({
      token: 'email-verification-fixture',
      type: 'email-verification',
      userId,
      workspaceId: workspace.id,
      expiresAt: new Date(Date.now() + 60000),
    });
    await tokens.insertUserToken({
      token: 'foreign-reset-fixture',
      type: 'forgot-password',
      userId: foreignUser,
      workspaceId: foreignWorkspace,
      expiresAt: new Date(Date.now() + 60000),
    });
    const result = await service.passwordReset(
      { token, newPassword },
      workspace as any,
    );
    expect(result).toEqual({ requiresLogin: true });
    const changed = await users.findById(userId, workspace.id, {
      includePassword: true,
    });
    expect(await comparePasswordHash(newPassword, changed.password)).toBe(true);
    expect(changed.hasGeneratedPassword).toBe(false);
    expect(await tokens.findById(token, workspace.id)).toBeUndefined();
    expect(
      await tokens.findById('email-verification-fixture', workspace.id),
    ).toBeDefined();
    expect(
      await tokens.findById('foreign-reset-fixture', foreignWorkspace),
    ).toBeDefined();
    const foreign = await users.findById(foreignUser, foreignWorkspace, {
      includePassword: true,
    });
    expect(foreign.password === initialHash).toBe(true);
    expect(
      await db
        .selectFrom('userSessions')
        .select('id')
        .where('userId', '=', userId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await db
        .selectFrom('userSessions')
        .select('id')
        .where('userId', '=', foreignUser)
        .execute(),
    ).toHaveLength(1);
    expect(minted).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledWith(userId);
  });

  it('rejects sequential replay', async () => {
    await service.passwordReset({ token, newPassword }, workspace as any);
    await expect(
      service.passwordReset(
        { token, newPassword: 'different-synthetic-password' },
        workspace as any,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'email-verification' },
    { usedAt: new Date() },
    { expiresAt: new Date(Date.now() - 60000) },
    { expiresAt: null },
    { workspaceId: foreignWorkspace },
  ])(
    'rejects an invalid token state %j without mutating credentials',
    async (change) => {
      await db
        .updateTable('userTokens')
        .set(change)
        .where('token', '=', token)
        .execute();
      await expect(
        service.passwordReset({ token, newPassword }, workspace as any),
      ).rejects.toThrow(BadRequestException);
      expect(
        (await users.findById(userId, workspace.id, { includePassword: true }))
          .password === initialHash,
      ).toBe(true);
      expect(
        await db
          .selectFrom('userSessions')
          .select('id')
          .where('userId', '=', userId)
          .execute(),
      ).toHaveLength(1);
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it.each(['deletedAt', 'deactivatedAt'])(
    'rejects a disabled account: %s',
    async (field) => {
      await db
        .updateTable('users')
        .set({ [field]: new Date() })
        .where('id', '=', userId)
        .execute();
      await expect(
        service.passwordReset({ token, newPassword }, workspace as any),
      ).rejects.toThrow(NotFoundException);
      expect(await tokens.findById(token, workspace.id)).toBeDefined();
      expect(
        (await users.findById(userId, workspace.id, { includePassword: true }))
          .password === initialHash,
      ).toBe(true);
    },
  );

  it('serializes different valid links for the same account', async () => {
    const other = 'second-' + randomUUID();
    await tokens.insertUserToken({
      token: other,
      userId,
      workspaceId: workspace.id,
      type: 'forgot-password',
      expiresAt: new Date(Date.now() + 60000),
    });
    const find = tokens.findById.bind(tokens);
    let reads = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(tokens, 'findById').mockImplementation(async (...args) => {
      const found = await find(...args);
      if (++reads === 2) release();
      await barrier;
      return found;
    });
    const results = await Promise.allSettled(
      [token, other].map((value) =>
        service.passwordReset({ token: value, newPassword }, workspace as any),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it.each(['expires', 'uses', 'disables'])(
    'rechecks state after a genuine user-row lock wait: %s',
    async (kind) => {
      let unlock!: () => void;
      let locked!: () => void;
      let holderPid!: number;
      const held = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = db.transaction().execute(async (trx) => {
        holderPid = (
          await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
            trx,
          )
        ).rows[0].pid;
        await trx
          .selectFrom('users')
          .select('id')
          .where('id', '=', userId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        locked();
        await held;
        if (kind === 'expires') {
          await trx
            .updateTable('userTokens')
            .set({ expiresAt: new Date(Date.now() - 60000) })
            .where('token', '=', token)
            .execute();
        } else if (kind === 'uses') {
          await trx
            .updateTable('userTokens')
            .set({ usedAt: new Date() })
            .where('token', '=', token)
            .execute();
        } else {
          await trx
            .updateTable('users')
            .set({ deactivatedAt: new Date() })
            .where('id', '=', userId)
            .execute();
        }
      });
      await ready;
      const pending = service.passwordReset(
        { token, newPassword },
        workspace as any,
      );
      const settled = pending.then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      try {
        let blocked = false;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const result = await sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`.execute(
            db,
          );
          if (result.rows[0].count > 0) {
            blocked = true;
            break;
          }
          await delay(10);
        }
        expect(blocked).toBe(true);
        unlock();
        await holding;
        const result = await settled;
        expect(result.error).toBeInstanceOf(
          kind === 'disables' ? NotFoundException : BadRequestException,
        );
        expect(
          (
            await users.findById(userId, workspace.id, {
              includePassword: true,
            })
          ).password === initialHash,
        ).toBe(true);
        expect(await tokens.findById(token, workspace.id)).toBeDefined();
        expect(
          await db
            .selectFrom('userSessions')
            .select('id')
            .where('userId', '=', userId)
            .execute(),
        ).toHaveLength(1);
      } finally {
        unlock();
        await Promise.allSettled([holding, settled]);
      }
    },
  );

  it('preserves cloud email verification inside the credential transaction', async () => {
    cloud.mockReturnValue(true);
    await service.passwordReset({ token, newPassword }, workspace as any);
    expect(
      (await users.findById(userId, workspace.id)).emailVerifiedAt,
    ).toBeInstanceOf(Date);
    expect(minted).not.toHaveBeenCalled();
  });

  it('does not deadlock with issuance of a replacement reset link', async () => {
    const insert = tokens.insertUserToken.bind(tokens);
    let holderPid!: number;
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    jest
      .spyOn(tokens, 'insertUserToken')
      .mockImplementation(async (value, opts) => {
        holderPid = (
          await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
            opts!.trx!,
          )
        ).rows[0].pid;
        ready();
        await held;
        return insert(value, opts);
      });
    const issuing = service
      .forgotPassword({ email: 'reset@example.invalid' }, workspace as any)
      .then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    await deleting;
    const resetting = service
      .passwordReset({ token, newPassword }, workspace as any)
      .then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    try {
      const deadline = Date.now() + 3000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))`.execute(
          db,
        );
        if (result.rows[0].count > 0) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      expect(blocked).toBe(true);
      release();
      const [issued, reset] = await Promise.all([issuing, resetting]);
      const safeCode = (error: any) =>
        typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
          ? error.code
          : null;
      if (safeCode(issued.error) || safeCode(reset.error)) {
        console.info(
          JSON.stringify({
            issuanceSqlState: safeCode(issued.error),
            resetSqlState: safeCode(reset.error),
          }),
        );
      }
      expect(issued.error === null).toBe(true);
      expect(reset.error instanceof BadRequestException).toBe(true);
      expect(
        (await users.findById(userId, workspace.id, { includePassword: true }))
          .password === initialHash,
      ).toBe(true);
    } finally {
      release();
      await Promise.allSettled([issuing, resetting]);
    }
  });

  it('does not consume or mutate anything without an explicit transaction', async () => {
    await expect(
      tokens.consumePasswordResetToken(token, workspace.id, userId, db as any),
    ).rejects.toThrow('requires a transaction');
    expect(await tokens.findById(token, workspace.id)).toBeDefined();
  });

  it.each([
    { enforceSso: false, enforceMfa: false },
    { enforceSso: true, enforceMfa: false },
    { enforceSso: false, enforceMfa: true },
    { enforceSso: true, enforceMfa: true },
  ])('HTTP reset never sends an auth cookie with policy %j', async (policy) => {
    Object.assign(workspace, policy);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset',
      payload: { token, newPassword },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ requiresLogin: true });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(minted).not.toHaveBeenCalled();
  });

  it('rejects invalid HTTP input without consuming the link', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset',
      payload: { token, newPassword: 'short' },
    });
    expect(response.statusCode).toBe(400);
    expect(await tokens.findById(token, workspace.id)).toBeDefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
