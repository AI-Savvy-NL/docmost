import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { CamelCasePlugin, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import * as postgres from 'postgres';
import { JwtService } from '@nestjs/jwt';
import { WikisavvyOidcRepo } from './oidc.repo';
import type { WikisavvyOidcService } from './oidc.service';
import { up as foundation } from '../../database/migrations/20261118T070000-wikisavvy-oidc-foundation';
import {
  up as pilot,
  down as undoPilot,
} from '../../database/migrations/20261118T163000-wikisavvy-oidc-pilot';
import { UserRepo } from '../../database/repos/user/user.repo';
import { UserSessionRepo } from '../../database/repos/session/user-session.repo';
import { SessionService } from '../session/session.service';
import { TokenService } from '../auth/services/token.service';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { hashPassword } from '../../common/helpers';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookie from '@fastify/cookie';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { DomainService } from '../../integrations/environment/domain.service';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';
import { JwtType } from '../auth/dto/jwt-payload';
import { TransformHttpResponseInterceptor } from '../../common/interceptors/http-response.interceptor';
import { createHash } from 'node:crypto';
import { WikisavvyOidcHttp } from './oidc-http';
import { setTimeout as delay } from 'node:timers/promises';

const url = process.env.WIKISAVVY_OIDC_TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;

integration('Optional SSO pilot with isolated PostgreSQL', () => {
  let root: Kysely<any>;
  let db: Kysely<any>;
  let repo: WikisavvyOidcRepo;
  let service: WikisavvyOidcService;
  let users: UserRepo;
  let sessions: UserSessionRepo;
  let jwt: JwtService;
  let sessionId: string;
  let providerId: string;
  let app: NestFastifyApplication;
  let sessionService: SessionService;
  let OIDC_BROWSER_COOKIE: string;
  const schema = 'oidc_pilot_' + randomBytes(8).toString('hex');
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const foreignWorkspace = randomUUID();
  const foreignUser = randomUUID();
  const fixtureSecret = randomBytes(32).toString('hex');
  const issuer = 'https://identity.example.invalid/application/o/wiki/';
  const password = 'synthetic-account-password';
  const callback = 'https://wiki.example.invalid/api/oidc/callback';
  const audit = { setActorId: jest.fn(), log: jest.fn() };
  const protocol = {
    check: jest.fn(async () => undefined),
    start: jest.fn(async () => {
      const state = randomBytes(32).toString('base64url');
      return {
        authorizationUrl: `${issuer}authorize?state=${state}`,
        redirectUri: callback,
        state,
        nonce: randomBytes(32).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
      };
    }),
    complete: jest.fn(async () => ({ issuer, subject: 'fixture-subject', amr: ['pwd', 'mfa'] })),
  };
  const environment = {
    getAppSecret: () => fixtureSecret,
    getAppUrl: () => 'https://wiki.example.invalid',
    getOidcAllowedOrigins: () => 'https://identity.example.invalid',
    getCookieExpiresIn: () => new Date(Date.now() + 60000),
    isCloud: () => false,
  };
  let initialHash: string;

  beforeAll(async () => {
    const { WikisavvyOidcService } =
      jest.requireActual<typeof import('./oidc.service')>('./oidc.service');
    const controller =
      jest.requireActual<typeof import('./oidc.controller')>(
        './oidc.controller',
      );
    const WikisavvyOidcController = controller.WikisavvyOidcController;
    OIDC_BROWSER_COOKIE = controller.OIDC_BROWSER_COOKIE;
    const parsed = new URL(url!);
    if (
      parsed.hostname !== '127.0.0.1' ||
      parsed.pathname !== '/wikisavvy_oidc_test'
    )
      throw new Error('Refusing a non-local OIDC test database');
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
      .addColumn('hostname', 'text')
      .addColumn('customDomain', 'text')
      .addColumn('deletedAt', 'timestamptz')
      .addColumn('enforceSso', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('enforceMfa', 'boolean', (c) => c.notNull().defaultTo(false))
      .execute();
    let table = db.schema
      .createTable('users')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('workspaceId', 'uuid', (c) =>
        c.notNull().references('workspaces.id'),
      )
      .addColumn('password', 'text', (c) => c.notNull())
      .addColumn('hasGeneratedPassword', 'boolean', (c) => c.defaultTo(false))
      .addColumn('settings', 'jsonb');
    for (const name of [
      'email',
      'name',
      'avatarUrl',
      'role',
      'locale',
      'timezone',
    ])
      table = table.addColumn(name, 'text');
    for (const name of [
      'emailVerifiedAt',
      'lastLoginAt',
      'deactivatedAt',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ])
      table = table.addColumn(name, 'timestamptz');
    await table.execute();
    await db.schema
      .createTable('userMfa')
      .addColumn('id', 'uuid', (c) => c.primaryKey())
      .addColumn('userId', 'uuid')
      .addColumn('method', 'text')
      .addColumn('isEnabled', 'boolean')
      .addColumn('createdAt', 'timestamptz')
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
      .addColumn('deviceName', 'text')
      .addColumn('ipAddress', 'text')
      .addColumn('expiresAt', 'timestamptz', (c) => c.notNull())
      .addColumn('revokedAt', 'timestamptz')
      .execute();
    await foundation(db);
    await pilot(db);
    repo = new WikisavvyOidcRepo(db as any);
    users = new UserRepo(db as any);
    sessions = new UserSessionRepo(db as any);
    jwt = new JwtService({
      secret: fixtureSecret,
      signOptions: { expiresIn: '60s' },
    });
    sessionService = new SessionService(
      new TokenService(jwt, environment as any),
      sessions,
      environment as any,
      { get: () => undefined } as any,
      {} as any,
    );
    service = new WikisavvyOidcService(
      db as any,
      repo,
      users,
      sessionService,
      new EncryptionService(environment as any),
      protocol as any,
      { getWorkspaceUrl: () => environment.getAppUrl() } as any,
      audit as any,
      environment as any,
    );
    const strategy = new JwtStrategy(
      users,
      {
        findById: async (id: string) =>
          db
            .selectFrom('workspaces')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirst(),
      } as any,
      sessions,
      { trackActivity: jest.fn() } as any,
      environment as any,
      {} as any,
    );
    const module = await Test.createTestingModule({
      controllers: [WikisavvyOidcController],
      providers: [
        { provide: WikisavvyOidcService, useValue: service },
        { provide: EnvironmentService, useValue: environment },
        {
          provide: DomainService,
          useValue: { getWorkspaceUrl: () => environment.getAppUrl() },
        },
        { provide: JwtStrategy, useValue: strategy },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const adapter = new FastifyAdapter();
    adapter.getInstance().addHook('onRequest', async (request) => {
      request.raw['workspace'] = await db
        .selectFrom('workspaces')
        .selectAll()
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      request.raw['workspaceId'] = workspaceId;
    });
    app = module.createNestApplication<NestFastifyApplication>(adapter, {
      logger: false,
    });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalInterceptors(
      new TransformHttpResponseInterceptor(new Reflector()),
    );
    await app.register(cookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    initialHash = await hashPassword(password);
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    protocol.check.mockReset().mockResolvedValue(undefined);
    protocol.start.mockReset().mockImplementation(async () => {
      const state = randomBytes(32).toString('base64url');
      return {
        authorizationUrl: `${issuer}authorize?state=${state}`,
        redirectUri: callback,
        state,
        nonce: randomBytes(32).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
      };
    });
    protocol.complete
      .mockReset()
      .mockResolvedValue({ issuer, subject: 'fixture-subject', amr: ['pwd', 'mfa'] });
    await db.deleteFrom('wikisavvyOidcTransactions').execute();
    await db.deleteFrom('wikisavvyOidcIdentities').execute();
    await db.deleteFrom('wikisavvyOidcProviders').execute();
    await db.deleteFrom('userSessions').execute();
    await db.deleteFrom('userMfa').execute();
    await db.deleteFrom('users').execute();
    await db.deleteFrom('workspaces').execute();
    await db
      .insertInto('workspaces')
      .values([{ id: workspaceId }, { id: foreignWorkspace }])
      .execute();
    await db
      .insertInto('users')
      .values([
        {
          id: userId,
          workspaceId,
          password: initialHash,
          email: 'owner@example.invalid',
          name: 'Owner',
          role: 'owner',
        },
        {
          id: foreignUser,
          workspaceId: foreignWorkspace,
          password: initialHash,
          email: 'foreign@example.invalid',
          name: 'Foreign',
          role: 'owner',
        },
      ])
      .execute();
    sessionId = (
      await sessions.insertSession({
        userId,
        workspaceId,
        expiresAt: new Date(Date.now() + 60000),
      })
    ).id;
    const created = await service.configure(workspaceId, userId, sessionId, {
      issuer,
      clientId: 'fixture-client',
      clientSecret: 'synthetic-client-proof',
      isEnabled: true,
      password,
    });
    providerId = created.id;
    jest.clearAllMocks();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    if (root) {
      await root.schema.dropSchema(schema).cascade().execute();
      await root.destroy();
    }
  });

  async function beginLink() {
    return service.start(workspaceId, providerId, {
      userId,
      sessionId,
      password,
    });
  }
  function callbackFor(start: { authorizationUrl: string }) {
    return new URL(
      `${callback}?code=synthetic-code&state=${new URL(start.authorizationUrl).searchParams.get('state')}`,
    );
  }
  function authCookie(
    withSession = true,
    actorId = userId,
    tenant = workspaceId,
  ) {
    return `authToken=${jwt.sign({ sub: actorId, email: 'fixture@example.invalid', workspaceId: tenant, type: JwtType.ACCESS, ...(withSession ? { sessionId } : {}) })}`;
  }
  function browserCookie(response: { headers: Record<string, unknown> }) {
    const cookies = response.headers['set-cookie'];
    const values = Array.isArray(cookies) ? cookies : [cookies];
    return String(
      values.find((value) =>
        String(value).startsWith(`${OIDC_BROWSER_COOKIE}=`),
      ) ?? '',
    ).split(';')[0];
  }

  it('explicitly links an existing account, then signs in through its persisted session', async () => {
    const link = await beginLink();
    const linked = await service.complete(
      workspaceId,
      callbackFor(link),
      link.browserBinding,
    );
    expect(linked.flow).toBe('link');
    expect('authToken' in linked).toBe(false);
    expect(
      (await repo.findIdentity(workspaceId, issuer, 'fixture-subject'))?.userId,
    ).toBe(userId);
    const login = await service.start(workspaceId, providerId);
    const result = await service.complete(
      workspaceId,
      callbackFor(login),
      login.browserBinding,
    );
    expect(result.flow).toBe('login');
    const payload = await jwt.verifyAsync(result.authToken!);
    expect((await sessions.findActiveById(payload.sessionId))?.userId).toBe(
      userId,
    );
  });

  it('refuses SSO when Authentik did not report a second factor, before any identity or session is written', async () => {
    const start = await service.start(workspaceId, providerId);
    const countIdentities = async () =>
      Number(
        (
          await db
            .selectFrom('wikisavvy_oidc_identities')
            .select(db.fn.countAll().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      );
    const before = await countIdentities();
    protocol.complete.mockResolvedValueOnce({ issuer, subject: 'fixture-subject', amr: ['pwd'] });
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow('SSO verification failed');
    expect(await countIdentities()).toBe(before);
  });

  it('rejects a callback from a different browser without consuming the correct flow', async () => {
    const start = await beginLink();
    await expect(
      service.complete(workspaceId, callbackFor(start), 'wrong-browser'),
    ).rejects.toThrow();
    expect(
      await repo.findIdentity(workspaceId, issuer, 'fixture-subject'),
    ).toBeUndefined();
    expect(
      (
        await service.complete(
          workspaceId,
          callbackFor(start),
          start.browserBinding,
        )
      ).flow,
    ).toBe('link');
  });

  it('completes HTTP linking and login without exposing proof material or minting a link session', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/oidc/link',
      headers: { origin: environment.getAppUrl(), cookie: authCookie() },
      payload: { providerId, password },
    });
    expect(start.statusCode).toBe(200);
    const body = start.json().data;
    expect(Object.keys(body)).toEqual(['authorizationUrl']);
    const bindingCookie = browserCookie(start);
    const bindingHeader = String(start.headers['set-cookie']);
    expect(
      bindingHeader.includes('HttpOnly') &&
        bindingHeader.includes('Secure') &&
        bindingHeader.includes('SameSite=Lax') &&
        bindingHeader.includes('Path=/'),
    ).toBe(true);
    const completed = await app.inject({
      method: 'GET',
      url: callbackFor(body).pathname + callbackFor(body).search,
      headers: { cookie: bindingCookie },
    });
    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe(
      '/settings/account/profile?oidc=linked',
    );
    expect(String(completed.headers['set-cookie']).includes('authToken=')).toBe(
      false,
    );
    expect(
      await db
        .selectFrom('userSessions')
        .select('id')
        .where('userId', '=', userId)
        .execute(),
    ).toHaveLength(1);
    const login = await app.inject({
      method: 'POST',
      url: '/api/oidc/start',
      headers: { origin: environment.getAppUrl() },
      payload: { providerId },
    });
    expect(login.statusCode).toBe(200);
    const loginUrl = callbackFor(login.json().data);
    const signedIn = await app.inject({
      method: 'GET',
      url: loginUrl.pathname + loginUrl.search,
      headers: { cookie: browserCookie(login) },
    });
    expect(signedIn.headers.location).toBe('/home');
    const headers = signedIn.headers['set-cookie'];
    const signedCookie = (Array.isArray(headers) ? headers : [headers]).find(
      (value) => String(value).startsWith('authToken='),
    );
    expect(Boolean(signedCookie)).toBe(true);
    const status = await app.inject({
      method: 'POST',
      url: '/api/oidc/status',
      headers: { cookie: String(signedCookie).split(';')[0] },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.providers[0].linked).toBe(true);
    const replay = await app.inject({
      method: 'GET',
      url: loginUrl.pathname + loginUrl.search,
      headers: { cookie: browserCookie(login) },
    });
    expect(replay.headers.location).toBe('/login?oidc=error');
    expect(String(replay.headers['set-cookie']).includes('authToken=')).toBe(
      false,
    );
  });

  it.each([
    'missing',
    'sessionless',
    'foreign',
    'member',
    'wrong-password',
    'cross-origin',
  ])('rejects unauthorized provider configuration: %s', async (kind) => {
    if (kind === 'member')
      await db
        .updateTable('users')
        .set({ role: 'member' })
        .where('id', '=', userId)
        .execute();
    const headers: Record<string, string> = {
      origin:
        kind === 'cross-origin'
          ? 'https://other.example.invalid'
          : environment.getAppUrl(),
    };
    if (kind !== 'missing')
      headers.cookie =
        kind === 'foreign'
          ? authCookie(false, foreignUser, foreignWorkspace)
          : authCookie(kind !== 'sessionless');
    const response = await app.inject({
      method: 'POST',
      url: '/api/oidc/configure',
      headers,
      payload: {
        id: providerId,
        issuer,
        clientId: 'fixture-client',
        isEnabled: false,
        password:
          kind === 'wrong-password' ? 'synthetic-wrong-password' : password,
      },
    });
    expect([401, 403].includes(response.statusCode)).toBe(true);
    expect((await repo.findProvider(workspaceId, providerId))?.isEnabled).toBe(
      true,
    );
  });

  it('rejects missing Origin and invalid DTOs without issuing cookies or proof records', async () => {
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/oidc/start',
      payload: { providerId },
    });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/oidc/start',
      headers: { origin: environment.getAppUrl() },
      payload: { providerId: 'not-an-id' },
    });
    expect(noOrigin.statusCode).toBe(403);
    expect(malformed.statusCode).toBe(400);
    expect(noOrigin.headers['set-cookie']).toBeUndefined();
    expect(malformed.headers['set-cookie']).toBeUndefined();
    expect(
      await db
        .selectFrom('wikisavvyOidcTransactions')
        .select('stateHash')
        .execute(),
    ).toHaveLength(0);
  });

  it('publishes only enabled provider identifiers/origins and owner metadata without secrets', async () => {
    const publicList = await app.inject({
      method: 'POST',
      url: '/api/oidc/providers',
    });
    expect(publicList.statusCode).toBe(200);
    expect(Object.keys(publicList.json().data[0]).sort()).toEqual([
      'id',
      'issuer',
    ]);
    const status = await app.inject({
      method: 'POST',
      url: '/api/oidc/status',
      headers: { cookie: authCookie() },
    });
    const publicText = publicList.body + status.body;
    expect(publicText.includes('synthetic-client-proof')).toBe(false);
    expect(publicText.includes('encryptedClientSecret')).toBe(false);
    expect(status.json().data.canManage).toBe(true);
    await service.configure(workspaceId, userId, sessionId, {
      id: providerId,
      issuer,
      clientId: 'fixture-client',
      isEnabled: false,
      password,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/oidc/providers' })).json()
        .data,
    ).toHaveLength(0);
  });

  it('stores only hashed browser/state binding and purpose-encrypted client/proof data', async () => {
    const start = await beginLink();
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const row = await db
      .selectFrom('wikisavvyOidcTransactions')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(
      row.stateHash === createHash('sha256').update(state).digest('hex'),
    ).toBe(true);
    expect(
      row.browserHash ===
        createHash('sha256').update(start.browserBinding).digest('hex'),
    ).toBe(true);
    const provider = await repo.findConfiguration(workspaceId, providerId);
    expect(provider!.encryptedClientSecret === 'synthetic-client-proof').toBe(
      false,
    );
    expect(
      row.encryptedPayload.includes(state) ||
        row.encryptedPayload.includes(initialHash) ||
        row.encryptedPayload.includes(start.browserBinding),
    ).toBe(false);
  });

  it('admits only one concurrent callback and one identity binding', async () => {
    const start = await beginLink();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        service.complete(workspaceId, callbackFor(start), start.browserBinding),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(protocol.complete).toHaveBeenCalledTimes(1);
    expect(
      await db.selectFrom('wikisavvyOidcIdentities').select('id').execute(),
    ).toHaveLength(1);
  });

  it.each([
    'expired',
    'wrong-workspace',
    'provider-disabled',
    'provider-rotated',
    'session-revoked',
    'password-reset',
    'disabled-user',
    'mfa',
    'enforced-sso',
  ])('rejects changed callback context: %s', async (kind) => {
    const start = await beginLink();
    if (kind === 'expired')
      await db
        .updateTable('wikisavvyOidcTransactions')
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .execute();
    if (kind === 'provider-disabled')
      await db
        .updateTable('wikisavvyOidcProviders')
        .set({ isEnabled: false })
        .where('id', '=', providerId)
        .execute();
    if (kind === 'provider-rotated')
      await db
        .updateTable('wikisavvyOidcProviders')
        .set({ revision: 2 })
        .where('id', '=', providerId)
        .execute();
    if (kind === 'session-revoked')
      await sessions.revokeById(sessionId, userId, workspaceId);
    if (kind === 'password-reset')
      await users.updateUser(
        { password: await hashPassword('synthetic-replaced-password') },
        userId,
        workspaceId,
      );
    if (kind === 'disabled-user')
      await users.updateUser(
        { deactivatedAt: new Date() },
        userId,
        workspaceId,
      );
    if (kind === 'mfa')
      await db
        .insertInto('userMfa')
        .values({ id: randomUUID(), userId, isEnabled: true })
        .execute();
    if (kind === 'enforced-sso')
      await db
        .updateTable('workspaces')
        .set({ enforceSso: true })
        .where('id', '=', workspaceId)
        .execute();
    await expect(
      service.complete(
        kind === 'wrong-workspace' ? foreignWorkspace : workspaceId,
        callbackFor(start),
        start.browserBinding,
      ),
    ).rejects.toThrow('SSO verification failed');
    expect(
      await repo.findIdentity(workspaceId, issuer, 'fixture-subject'),
    ).toBeUndefined();
    expect(
      await db.selectFrom('userSessions').select('id').execute(),
    ).toHaveLength(1);
  });

  it('rejects unlinked identities rather than looking up an account by email or creating one', async () => {
    const start = await service.start(workspaceId, providerId);
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow();
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(2);
    expect(
      await db.selectFrom('userSessions').select('id').execute(),
    ).toHaveLength(1);
  });

  it('cannot steal an existing binding for another local account', async () => {
    await db.transaction().execute((trx) =>
      repo.insertIdentity(
        {
          workspaceId,
          providerId,
          issuer,
          subject: 'fixture-subject',
          userId,
        },
        trx as any,
      ),
    );
    const localOther = randomUUID();
    await db
      .insertInto('users')
      .values({
        id: localOther,
        workspaceId,
        password: initialHash,
        role: 'member',
        email: 'another@example.invalid',
      })
      .execute();
    const otherSession = await sessions.insertSession({
      userId: localOther,
      workspaceId,
      expiresAt: new Date(Date.now() + 60000),
    });
    const start = await service.start(workspaceId, providerId, {
      userId: localOther,
      sessionId: otherSession.id,
      password,
    });
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow();
    expect(
      (await repo.findIdentity(workspaceId, issuer, 'fixture-subject'))?.userId,
    ).toBe(userId);
  });

  it('rolls back an inserted login session and last-login update if signing fails', async () => {
    const link = await beginLink();
    await service.complete(workspaceId, callbackFor(link), link.browserBinding);
    const start = await service.start(workspaceId, providerId);
    const insert = sessionService.createSessionAndToken.bind(sessionService);
    jest
      .spyOn(sessionService, 'createSessionAndToken')
      .mockImplementation(async (...args) => {
        await insert(...args);
        throw new Error('synthetic-signing-failure');
      });
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow();
    expect((await users.findById(userId, workspaceId)).lastLoginAt).toBeNull();
    expect(
      await db.selectFrom('userSessions').select('id').execute(),
    ).toHaveLength(1);
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow();
  });

  it('rejects provider disablement during exchange before persisting identity/session', async () => {
    const start = await beginLink();
    protocol.complete.mockImplementationOnce(async () => {
      await db
        .updateTable('wikisavvyOidcProviders')
        .set({ isEnabled: false, revision: 2 })
        .where('id', '=', providerId)
        .execute();
      return { issuer, subject: 'fixture-subject', amr: ['pwd', 'mfa'] };
    });
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow();
    expect(
      await repo.findIdentity(workspaceId, issuer, 'fixture-subject'),
    ).toBeUndefined();
  });

  it('preserves the verified-email requirement for existing cloud accounts', async () => {
    const start = await beginLink();
    jest.spyOn(environment, 'isCloud').mockReturnValue(true);
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow();
    expect(
      await repo.findIdentity(workspaceId, issuer, 'fixture-subject'),
    ).toBeUndefined();
    expect(
      (await users.findById(userId, workspaceId)).emailVerifiedAt,
    ).toBeNull();
  });

  it('rechecks proof expiry after a genuine database row-lock wait', async () => {
    const start = await beginLink();
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    const stateHash = createHash('sha256').update(state).digest('hex');
    const expiresAt = new Date(Date.now() + 700);
    await db
      .updateTable('wikisavvyOidcTransactions')
      .set({ expiresAt })
      .where('stateHash', '=', stateHash)
      .execute();
    let ready!: () => void;
    let release!: () => void;
    let pid!: number;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = db.transaction().execute(async (trx) => {
      pid = (
        await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)
      ).rows[0].pid;
      await trx
        .selectFrom('wikisavvyOidcTransactions')
        .select('stateHash')
        .where('stateHash', '=', stateHash)
        .forUpdate()
        .executeTakeFirstOrThrow();
      ready();
      await held;
    });
    await locked;
    const pending = service
      .complete(workspaceId, callbackFor(start), start.browserBinding)
      .then(
        () => true,
        () => false,
      );
    try {
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const row = await sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`.execute(
          db,
        );
        if (row.rows[0].count) {
          blocked = true;
          break;
        }
        await delay(10);
      }
      expect(blocked).toBe(true);
      while (Date.now() <= expiresAt.getTime() + 30) await delay(10);
      release();
      await holding;
      expect(await pending).toBe(false);
      expect(
        await repo.findIdentity(workspaceId, issuer, 'fixture-subject'),
      ).toBeUndefined();
    } finally {
      release();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('disables owned providers and drops pending proofs on migration rollback without removing users', async () => {
    const start = await beginLink();
    await undoPilot(db);
    try {
      const row = await db
        .selectFrom('wikisavvyOidcProviders')
        .select('isEnabled')
        .where('id', '=', providerId)
        .executeTakeFirstOrThrow();
      expect(row.isEnabled).toBe(false);
      expect(await db.selectFrom('users').select('id').execute()).toHaveLength(
        2,
      );
      expect(
        await db.selectFrom('userSessions').select('id').execute(),
      ).toHaveLength(1);
    } finally {
      await pilot(db);
    }
    await expect(
      service.complete(workspaceId, callbackFor(start), start.browserBinding),
    ).rejects.toThrow();
  });

  it('runs the HTTP linking/login pipeline through the real SDK and rejects a bad issuer signature', async () => {
    const { WikisavvyOidcProtocol } =
      jest.requireActual<typeof import('./oidc-protocol')>('./oidc-protocol');
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = {
      ...keys.publicKey.export({ format: 'jwk' }),
      kid: 'pilot-fixture',
      alg: 'RS256',
      use: 'sig',
    };
    const http = new WikisavvyOidcHttp(environment as any, {} as any);
    let nonce = '';
    let challenge = '';
    let tampered = false;
    let validatedRequests = 0;
    jest
      .spyOn(http, 'fetch')
      .mockImplementation(async (_issuer, url, options) => {
        if (url.includes('.well-known/openid-configuration'))
          return Response.json({
            issuer,
            authorization_endpoint:
              'https://identity.example.invalid/authorize',
            token_endpoint: 'https://identity.example.invalid/token',
            jwks_uri: 'https://identity.example.invalid/jwks',
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_post'],
          });
        if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
        if (url.endsWith('/token')) {
          const body = new URLSearchParams(options.body as string);
          const matches =
            body.get('client_secret') === 'synthetic-client-proof' &&
            body.get('redirect_uri') === callback &&
            createHash('sha256')
              .update(body.get('code_verifier') ?? '')
              .digest('base64url') === challenge;
          if (!matches)
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          validatedRequests++;
          const now = Math.floor(Date.now() / 1000);
          const header = Buffer.from(
            JSON.stringify({ alg: 'RS256', kid: 'pilot-fixture' }),
          ).toString('base64url');
          const claims = Buffer.from(
            JSON.stringify({
              iss: issuer,
              sub: 'fixture-subject',
              amr: ['pwd', 'mfa'],
              aud: 'fixture-client',
              iat: now,
              exp: now + 120,
              nonce,
            }),
          ).toString('base64url');
          const input = `${header}.${claims}`;
          let signature = sign(
            'RSA-SHA256',
            Buffer.from(input),
            keys.privateKey,
          ).toString('base64url');
          if (tampered)
            signature = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
          return Response.json({
            access_token: 'synthetic-provider-proof',
            token_type: 'Bearer',
            id_token: `${input}.${signature}`,
          });
        }
        throw new Error('Unexpected controlled issuer endpoint');
      });
    const engine = new WikisavvyOidcProtocol(http);
    protocol.check.mockImplementation(async (...args: any[]) =>
      engine.check(args[0]),
    );
    protocol.start.mockImplementation(async (...args: any[]) =>
      engine.start(args[0], args[1]),
    );
    protocol.complete.mockImplementation(async (...args: any[]) =>
      engine.complete(args[0], args[1], args[2]),
    );
    await service.configure(workspaceId, userId, sessionId, {
      id: providerId,
      issuer,
      clientId: 'fixture-client',
      isEnabled: true,
      password,
    });
    async function roundTrip(link: boolean) {
      const started = await app.inject({
        method: 'POST',
        url: link ? '/api/oidc/link' : '/api/oidc/start',
        headers: {
          origin: environment.getAppUrl(),
          ...(link ? { cookie: authCookie() } : {}),
        },
        payload: { providerId, ...(link ? { password } : {}) },
      });
      expect(started.statusCode).toBe(200);
      const authorization = new URL(started.json().data.authorizationUrl);
      nonce = authorization.searchParams.get('nonce')!;
      challenge = authorization.searchParams.get('code_challenge')!;
      const target = new URL(callback);
      target.searchParams.set('code', 'synthetic-issuer-code');
      target.searchParams.set(
        'state',
        authorization.searchParams.get('state')!,
      );
      return app.inject({
        method: 'GET',
        url: target.pathname + target.search,
        headers: { cookie: browserCookie(started) },
      });
    }
    expect((await roundTrip(true)).headers.location).toBe(
      '/settings/account/profile?oidc=linked',
    );
    const login = await roundTrip(false);
    expect(login.headers.location).toBe('/home');
    expect(String(login.headers['set-cookie']).includes('authToken=')).toBe(
      true,
    );
    const count = (await db.selectFrom('userSessions').select('id').execute())
      .length;
    tampered = true;
    const rejected = await roundTrip(false);
    expect(rejected.headers.location).toBe('/login?oidc=error');
    expect(String(rejected.headers['set-cookie']).includes('authToken=')).toBe(
      false,
    );
    expect(
      (await db.selectFrom('userSessions').select('id').execute()).length,
    ).toBe(count);
    expect(validatedRequests).toBe(3);
  });
});
