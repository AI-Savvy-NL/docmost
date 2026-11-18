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
  UnauthorizedException,
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
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';
import { JwtStrategy } from '../strategies/jwt.strategy';

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
  let jwt: JwtService;
  let strategy: JwtStrategy;
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
  const fixtureSecret = randomBytes(32).toString('hex');

  function gate() {
    let open!: () => void;
    const ready = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { ready, open };
  }

  async function waitForBlocker(holderPid: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE ${holderPid} = ANY(pg_blocking_pids(pid))
      `.execute(db);
      if (result.rows[0].count > 0) return true;
      await delay(10);
    }
    return false;
  }

  async function changeWhileWaiting(
    request: () => Promise<unknown>,
    change: Record<string, unknown>,
  ) {
    const ready = gate();
    const release = gate();
    let holderPid!: number;
    const holding = db.transaction().execute(async (trx) => {
      holderPid = (
        await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      ).rows[0].pid;
      await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', userId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      ready.open();
      await release.ready;
      await trx
        .updateTable('users')
        .set(change)
        .where('id', '=', userId)
        .execute();
    });
    await ready.ready;
    const pending = request().then(
      () => ({ succeeded: true, error: null }),
      (error) => ({ succeeded: false, error }),
    );
    try {
      expect(await waitForBlocker(holderPid)).toBe(true);
      release.open();
      await holding;
      return await pending;
    } finally {
      release.open();
      await Promise.allSettled([holding, pending]);
    }
  }

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
      .addColumn('deviceName', 'text')
      .addColumn('ipAddress', 'text')
      .execute();
    users = new UserRepo(db as any);
    tokens = new UserTokenRepo(db as any);
    sessions = new UserSessionRepo(db as any);
    const environment = {
      isCloud: cloud,
      getAppSecret: () => fixtureSecret,
      getCookieExpiresIn: () => new Date(Date.now() + 60000),
    };
    jwt = new JwtService({
      secret: fixtureSecret,
      signOptions: { expiresIn: '60s' },
    });
    const signer = new TokenService(jwt, environment as any);
    minted.mockImplementation(signer.generateAccessToken.bind(signer));
    const sessionService = new SessionService(
      { generateAccessToken: minted } as any,
      sessions,
      environment as any,
      { get: () => undefined } as any,
      {} as any,
    );
    strategy = new JwtStrategy(
      users,
      { findById: async () => workspace } as any,
      sessions,
      { trackActivity: jest.fn() } as any,
      environment as any,
      {} as any,
    );
    service = new AuthService(
      {} as any,
      {} as any,
      sessionService,
      sessions,
      users,
      tokens,
      mail as any,
      { getUrl: () => 'https://recovery.example.invalid' } as any,
      environment as any,
      { emitAsync: jest.fn() } as any,
      db as any,
      audit as any,
      {
        disconnectUser: disconnect,
        disconnectOtherSessions: disconnect,
      } as any,
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

  it.each(['reset', 'change'])(
    'rejects old-password login whose account snapshot predates password %s',
    async (kind) => {
      const find = users.findByEmail.bind(users);
      let observed!: () => void;
      let release!: () => void;
      const captured = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(users, 'findByEmail').mockImplementation(async (...args) => {
        const snapshot = await find(...args);
        observed();
        await held;
        return snapshot;
      });
      const loggingIn = service
        .login(
          {
            email: 'reset@example.invalid',
            password: 'synthetic-original-password',
          },
          workspace.id,
        )
        .then(
          () => ({ succeeded: true, error: null }),
          (error) => ({ succeeded: false, error }),
        );
      try {
        await captured;
        if (kind === 'reset') {
          await service.passwordReset({ token, newPassword }, workspace as any);
        } else {
          await service.changePassword(
            { oldPassword: 'synthetic-original-password', newPassword },
            userId,
            workspace.id,
          );
        }
        release();
        const result = await loggingIn;
        expect(result.succeeded).toBe(false);
        expect(result.error).toBeInstanceOf(UnauthorizedException);
        expect(
          await db
            .selectFrom('userSessions')
            .select('id')
            .where('userId', '=', userId)
            .execute(),
        ).toHaveLength(0);
        expect(minted).not.toHaveBeenCalled();
      } finally {
        release();
        await loggingIn;
      }
    },
  );

  it.each([true, false])(
    'rolls back ordinary password change after actual session deletion fails, keep current=%s',
    async (keepCurrent) => {
      const current = await db
        .selectFrom('userSessions')
        .select('id')
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow();
      await sessions.insertSession({
        userId,
        workspaceId: workspace.id,
        expiresAt: new Date(Date.now() + 60000),
      });
      if (keepCurrent) {
        const remove = sessions.deleteAllExceptCurrent.bind(sessions);
        jest
          .spyOn(sessions, 'deleteAllExceptCurrent')
          .mockImplementation(async (...args) => {
            await remove(...args);
            throw new Error('synthetic-session-storage-failure');
          });
      } else {
        const remove = sessions.deleteByUserId.bind(sessions);
        jest
          .spyOn(sessions, 'deleteByUserId')
          .mockImplementation(async (...args) => {
            await remove(...args);
            throw new Error('synthetic-session-storage-failure');
          });
      }
      await expect(
        service.changePassword(
          {
            oldPassword: 'synthetic-original-password',
            newPassword,
          },
          userId,
          workspace.id,
          keepCurrent ? current.id : undefined,
        ),
      ).rejects.toThrow('synthetic-session-storage-failure');
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
      ).toHaveLength(2);
      expect(disconnect).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each(['reset', 'change'])(
    'removes a newly committed login when password %s follows the login lock',
    async (kind) => {
      const insert = sessions.insertSession.bind(sessions);
      const inserting = gate();
      const release = gate();
      let holderPid!: number;
      jest
        .spyOn(sessions, 'insertSession')
        .mockImplementation(async (value, trx) => {
          expect(trx?.isTransaction).toBe(true);
          holderPid = (
            await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
              trx!,
            )
          ).rows[0].pid;
          inserting.open();
          await release.ready;
          return insert(value, trx);
        });
      const current = await db
        .selectFrom('userSessions')
        .select('id')
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow();
      const loggingIn = service.login(
        {
          email: 'reset@example.invalid',
          password: 'synthetic-original-password',
        },
        workspace.id,
      );
      const loginSettled = loggingIn.then(
        (value) => ({ value, succeeded: true }),
        () => ({ value: '', succeeded: false }),
      );
      let mutation: Promise<unknown> | undefined;
      try {
        await inserting.ready;
        mutation =
          kind === 'reset'
            ? service.passwordReset({ token, newPassword }, workspace as any)
            : service.changePassword(
                { oldPassword: 'synthetic-original-password', newPassword },
                userId,
                workspace.id,
                current.id,
              );
        const changing = mutation.then(
          () => true,
          () => false,
        );
        expect(await waitForBlocker(holderPid)).toBe(true);
        release.open();
        const login = await loginSettled;
        expect(login.succeeded).toBe(true);
        expect(await changing).toBe(true);
        const payload = await jwt.verifyAsync(login.value);
        expect(
          await sessions.findActiveById(payload.sessionId),
        ).toBeUndefined();
        await expect(
          strategy.validate({ raw: { workspaceId: workspace.id } }, payload),
        ).rejects.toThrow(UnauthorizedException);
        expect(Boolean(await sessions.findActiveById(current.id))).toBe(
          kind === 'change',
        );
      } finally {
        release.open();
        await Promise.allSettled([
          loginSettled,
          ...(mutation ? [mutation] : []),
        ]);
      }
    },
  );

  it.each([
    'password',
    'deactivatedAt',
    'deletedAt',
    'email',
    'emailVerifiedAt',
  ])('rechecks login after account lock wait: %s', async (field) => {
    if (field === 'emailVerifiedAt') {
      cloud.mockReturnValue(true);
      await db
        .updateTable('users')
        .set({ emailVerifiedAt: new Date() })
        .where('id', '=', userId)
        .execute();
    }
    const change =
      field === 'password'
        ? { password: await hashPassword('synthetic-replaced-password') }
        : field === 'email'
          ? { email: 'changed@example.invalid' }
          : field === 'emailVerifiedAt'
            ? { emailVerifiedAt: null }
            : { [field]: new Date() };
    const result = await changeWhileWaiting(
      () =>
        service.login(
          {
            email: 'reset@example.invalid',
            password: 'synthetic-original-password',
          },
          workspace.id,
        ),
      change,
    );
    expect(result.succeeded).toBe(false);
    expect(result.error).toBeInstanceOf(
      field === 'emailVerifiedAt' ? BadRequestException : UnauthorizedException,
    );
    expect((await users.findById(userId, workspace.id)).lastLoginAt).toBeNull();
    expect(
      await db
        .selectFrom('userSessions')
        .select('id')
        .where('userId', '=', userId)
        .execute(),
    ).toHaveLength(1);
    expect(minted).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each(['password', 'deactivatedAt', 'deletedAt'])(
    'rechecks ordinary password change after account lock wait: %s',
    async (field) => {
      const replacementHash = await hashPassword('synthetic-replaced-password');
      const result = await changeWhileWaiting(
        () =>
          service.changePassword(
            {
              oldPassword: 'synthetic-original-password',
              newPassword,
            },
            userId,
            workspace.id,
          ),
        field === 'password'
          ? { password: replacementHash }
          : { [field]: new Date() },
      );
      expect(result.succeeded).toBe(false);
      expect(result.error).toBeInstanceOf(
        field === 'password' ? BadRequestException : NotFoundException,
      );
      const state = await users.findById(userId, workspace.id, {
        includePassword: true,
      });
      expect(
        state.password ===
          (field === 'password' ? replacementHash : initialHash),
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

  it('allows only one competing password change using the same old password', async () => {
    const find = users.findById.bind(users);
    const captured = gate();
    let count = 0;
    jest.spyOn(users, 'findById').mockImplementation(async (...args) => {
      const snapshot = await find(...args);
      if (!args[2]?.trx && args[2]?.includePassword) {
        if (++count === 2) captured.open();
        await captured.ready;
      }
      return snapshot;
    });
    const results = await Promise.allSettled(
      [newPassword, 'synthetic-competing-password'].map((next) =>
        service.changePassword(
          {
            oldPassword: 'synthetic-original-password',
            newPassword: next,
          },
          userId,
          workspace.id,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(await tokens.findById(token, workspace.id)).toBeDefined();
  });

  it.each([true, false])(
    'preserves ordinary password-change session policy and foreign data, keep current=%s',
    async (keepCurrent) => {
      const current = await db
        .selectFrom('userSessions')
        .select('id')
        .where('userId', '=', userId)
        .executeTakeFirstOrThrow();
      await sessions.insertSession({
        userId,
        workspaceId: workspace.id,
        expiresAt: new Date(Date.now() + 60000),
      });
      await service.changePassword(
        { oldPassword: 'synthetic-original-password', newPassword },
        userId,
        workspace.id,
        keepCurrent ? current.id : undefined,
      );
      const changed = await users.findById(userId, workspace.id, {
        includePassword: true,
      });
      expect(await comparePasswordHash(newPassword, changed.password)).toBe(
        true,
      );
      expect(changed.hasGeneratedPassword).toBe(false);
      expect(
        await db
          .selectFrom('userSessions')
          .select('id')
          .where('userId', '=', userId)
          .execute(),
      ).toHaveLength(keepCurrent ? 1 : 0);
      expect(Boolean(await sessions.findActiveById(current.id))).toBe(
        keepCurrent,
      );
      expect(
        await db
          .selectFrom('userSessions')
          .select('id')
          .where('userId', '=', foreignUser)
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await users.findById(foreignUser, foreignWorkspace, {
            includePassword: true,
          })
        ).password === initialHash,
      ).toBe(true);
      expect(await tokens.findById(token, workspace.id)).toBeDefined();
      expect(minted).not.toHaveBeenCalled();
    },
  );

  it.each(['insert', 'sign'])(
    'rolls back login session and last-login time on failed %s',
    async (kind) => {
      if (kind === 'insert') {
        const insert = sessions.insertSession.bind(sessions);
        jest
          .spyOn(sessions, 'insertSession')
          .mockImplementation(async (...args) => {
            await insert(...args);
            throw new Error('synthetic-login-storage-failure');
          });
      } else {
        minted.mockRejectedValueOnce(
          new Error('synthetic-login-storage-failure'),
        );
      }
      await expect(
        service.login(
          {
            email: 'reset@example.invalid',
            password: 'synthetic-original-password',
          },
          workspace.id,
        ),
      ).rejects.toThrow('synthetic-login-storage-failure');
      expect(
        (await users.findById(userId, workspace.id)).lastLoginAt,
      ).toBeNull();
      expect(
        await db
          .selectFrom('userSessions')
          .select('id')
          .where('userId', '=', userId)
          .execute(),
      ).toHaveLength(1);
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isCloud: false, email: 'reset@example.invalid' },
    { isCloud: false, email: 'RESET@EXAMPLE.INVALID' },
    { isCloud: true, email: 'reset@example.invalid' },
  ])(
    'returns a signed, accepted persisted-session login: %j',
    async ({ isCloud, email }) => {
      cloud.mockReturnValue(isCloud);
      if (isCloud)
        await db
          .updateTable('users')
          .set({ emailVerifiedAt: new Date() })
          .where('id', '=', userId)
          .execute();
      const signed = await service.login(
        { email, password: 'synthetic-original-password' },
        workspace.id,
      );
      const payload = await jwt.verifyAsync(signed);
      const result = await strategy.validate(
        { raw: { workspaceId: workspace.id } },
        payload,
      );
      expect(result.user.id).toBe(userId);
      expect((await sessions.findActiveById(payload.sessionId))?.userId).toBe(
        userId,
      );
      expect(
        (await users.findById(userId, workspace.id)).lastLoginAt,
      ).toBeInstanceOf(Date);
      expect(minted).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['wrong-password', 'missing', 'foreign', 'disabled', 'unverified'])(
    'rejects login without new sessions or last-login changes: %s',
    async (kind) => {
      if (kind === 'disabled')
        await db
          .updateTable('users')
          .set({ deactivatedAt: new Date() })
          .where('id', '=', userId)
          .execute();
      if (kind === 'unverified') cloud.mockReturnValue(true);
      const email =
        kind === 'missing'
          ? 'missing@example.invalid'
          : kind === 'foreign'
            ? 'foreign@example.invalid'
            : 'reset@example.invalid';
      await expect(
        service.login(
          {
            email,
            password:
              kind === 'wrong-password'
                ? 'synthetic-wrong-password'
                : 'synthetic-original-password',
          },
          workspace.id,
        ),
      ).rejects.toThrow(
        kind === 'unverified' ? BadRequestException : UnauthorizedException,
      );
      expect(
        (await users.findById(userId, workspace.id)).lastLoginAt,
      ).toBeNull();
      expect(
        await db.selectFrom('userSessions').select('id').execute(),
      ).toHaveLength(2);
      expect(minted).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it.each(['wrong-password', 'missing', 'foreign', 'disabled'])(
    'rejects ordinary password change without mutation: %s',
    async (kind) => {
      if (kind === 'disabled')
        await db
          .updateTable('users')
          .set({ deactivatedAt: new Date() })
          .where('id', '=', userId)
          .execute();
      const targetId =
        kind === 'missing'
          ? randomUUID()
          : kind === 'foreign'
            ? foreignUser
            : userId;
      await expect(
        service.changePassword(
          {
            oldPassword:
              kind === 'wrong-password'
                ? 'synthetic-wrong-password'
                : 'synthetic-original-password',
            newPassword,
          },
          targetId,
          workspace.id,
        ),
      ).rejects.toThrow(
        kind === 'wrong-password' ? BadRequestException : NotFoundException,
      );
      expect(
        (await users.findById(userId, workspace.id, { includePassword: true }))
          .password === initialHash,
      ).toBe(true);
      expect(
        await db.selectFrom('userSessions').select('id').execute(),
      ).toHaveLength(2);
      expect(disconnect).not.toHaveBeenCalled();
    },
  );
});
