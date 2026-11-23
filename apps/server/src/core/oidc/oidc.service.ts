import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../database/types/kysely.types';
import { UserRepo } from '../../database/repos/user/user.repo';
import { SessionService } from '../session/session.service';
import {
  EncryptionPurpose,
  EncryptionService,
} from '../../integrations/encryption/encryption.service';
import { DomainService } from '../../integrations/environment/domain.service';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { UserRole } from '../../common/helpers/types/permission';
import { comparePasswordHash, isUserDisabled } from '../../common/helpers';
import { WikisavvyOidcRepo } from './oidc.repo';
import { OidcProof, WikisavvyOidcProtocol } from './oidc-protocol';
import { satisfiesRequiredMfa } from './oidc-mfa';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { throwIfEmailNotVerified } from '../auth/auth.util';

export const OIDC_FLOW_SECONDS = 300;
const fail = () =>
  new BadRequestException('SSO verification failed. Please start again.');
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export interface ConfigureOidc {
  id?: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  isEnabled: boolean;
  password: string;
}
type LinkActor = { userId: string; sessionId: string; password: string };
type SavedProof = OidcProof & {
  workspaceId: string;
  providerId: string;
  revision: number;
  stateHash: string;
  flow: 'login' | 'link';
  actor?: { userId: string; sessionId: string; passwordHash: string };
};

@Injectable()
export class WikisavvyOidcService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly repo: WikisavvyOidcRepo,
    private readonly users: UserRepo,
    private readonly sessions: SessionService,
    private readonly encryption: EncryptionService,
    private readonly protocol: WikisavvyOidcProtocol,
    private readonly domain: DomainService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
    private readonly environment: EnvironmentService,
  ) {}

  private async workspace(workspaceId: string, trx?: KyselyTransaction) {
    let query = (trx ?? this.db)
      .selectFrom('workspaces')
      .select([
        'id',
        'hostname',
        'customDomain',
        'enforceSso',
        'enforceMfa',
        'deletedAt',
      ])
      .where('id', '=', workspaceId);
    if (trx) query = query.forShare();
    const workspace = await query.executeTakeFirst();
    if (
      !workspace ||
      workspace.deletedAt ||
      workspace.enforceSso ||
      workspace.enforceMfa
    )
      throw fail();
    const origin = new URL(this.domain.getWorkspaceUrl(workspace)).origin;
    if (!origin.startsWith('https://')) throw fail();
    return { ...workspace, origin, callbackUrl: `${origin}/api/oidc/callback` };
  }

  private async passwordSnapshot(
    workspaceId: string,
    userId: string,
    password: string,
  ) {
    const user = await this.users.findById(userId, workspaceId, {
      includePassword: true,
      includeUserMfa: true,
    });
    if (
      !user ||
      isUserDisabled(user) ||
      !password ||
      !(await comparePasswordHash(password, user.password))
    )
      throw new ForbiddenException('Password reauthentication required');
    return user;
  }

  private async lockedUser(
    workspaceId: string,
    userId: string,
    trx: KyselyTransaction,
  ) {
    const account = await trx
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!account) throw fail();
    const user = await this.users.findById(userId, workspaceId, {
      includePassword: true,
      includeUserMfa: true,
      trx,
    });
    if (!user || isUserDisabled(user)) throw fail();
    return user;
  }

  private async liveSession(
    workspaceId: string,
    userId: string,
    sessionId: string,
    trx: KyselyTransaction,
  ) {
    const session = await trx
      .selectFrom('userSessions')
      .select('id')
      .where('id', '=', sessionId)
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .forShare()
      .executeTakeFirst();
    if (!session) throw fail();
  }

  private client(provider: {
    issuer: string;
    clientId: string;
    encryptedClientSecret: string | null;
  }) {
    if (!provider.encryptedClientSecret) throw fail();
    return {
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: this.encryption.decrypt(
        provider.encryptedClientSecret,
        EncryptionPurpose.OIDC_CLIENT,
      ),
    };
  }

  async publicProviders(workspaceId: string) {
    try {
      await this.workspace(workspaceId);
      const providers = await this.repo.listProviders(workspaceId, true);
      return providers.map((provider) => ({
        id: provider.id,
        issuer: new URL(provider.issuer).origin,
      }));
    } catch {
      return [];
    }
  }

  async status(workspaceId: string, userId: string) {
    const workspace = await this.workspace(workspaceId);
    const user = await this.users.findById(userId, workspaceId);
    if (!user || isUserDisabled(user)) throw new ForbiddenException();
    const canManage = user.role === UserRole.OWNER;
    const [providers, identities] = await Promise.all([
      this.repo.listProviders(workspaceId, !canManage),
      this.repo.identitiesForUser(workspaceId, userId),
    ]);
    return {
      canManage,
      callbackUrl: workspace.callbackUrl,
      providers: providers.map((provider) => ({
        id: provider.id,
        issuer: provider.issuer,
        isEnabled: provider.isEnabled,
        ...(canManage ? { clientId: provider.clientId } : {}),
        linked: identities.some(
          (identity) => identity.providerId === provider.id,
        ),
      })),
    };
  }

  async assertOrigin(workspaceId: string, origin?: string) {
    const workspace = await this.workspace(workspaceId);
    if (origin !== workspace.origin)
      throw new ForbiddenException('Same-origin request required');
  }

  async configure(
    workspaceId: string,
    userId: string,
    sessionId: string,
    value: ConfigureOidc,
  ) {
    await this.workspace(workspaceId);
    const snapshot = await this.passwordSnapshot(
      workspaceId,
      userId,
      value.password,
    );
    if (snapshot.role !== UserRole.OWNER) throw new ForbiddenException();
    const before = value.id
      ? await this.repo.findConfiguration(workspaceId, value.id)
      : undefined;
    if (
      value.id &&
      (!before ||
        before.issuer !== value.issuer ||
        before.clientId !== value.clientId)
    )
      throw fail();
    const encrypted = value.clientSecret
      ? this.encryption.encrypt(
          value.clientSecret,
          EncryptionPurpose.OIDC_CLIENT,
        )
      : before?.encryptedClientSecret;
    if (!encrypted) throw new BadRequestException('Client secret required');
    if (value.isEnabled) {
      try {
        await this.protocol.check(
          this.client({
            issuer: value.issuer,
            clientId: value.clientId,
            encryptedClientSecret: encrypted,
          }),
        );
      } catch {
        throw fail();
      }
    }
    const saved = await this.db.transaction().execute(async (trx) => {
      await this.workspace(workspaceId, trx);
      const current = await this.lockedUser(workspaceId, userId, trx);
      if (
        current.role !== UserRole.OWNER ||
        current.password !== snapshot.password
      )
        throw new ForbiddenException();
      await this.liveSession(workspaceId, userId, sessionId, trx);
      const provider =
        before ??
        (await this.repo.insertProvider(
          { workspaceId, issuer: value.issuer, clientId: value.clientId },
          trx,
        ));
      const result = await this.repo.saveConfiguration(
        workspaceId,
        provider.id,
        encrypted,
        value.isEnabled,
        before?.revision ?? 0,
        trx,
      );
      if (!result) throw fail();
      return result;
    });
    this.audit.setActorId(userId);
    this.audit.log({
      event: before
        ? AuditEvent.SSO_PROVIDER_UPDATED
        : AuditEvent.SSO_PROVIDER_CREATED,
      resourceType: AuditResource.SSO_PROVIDER,
      resourceId: saved.id,
      metadata: { enabled: saved.isEnabled },
    });
    return saved;
  }

  async start(workspaceId: string, providerId: string, actor?: LinkActor) {
    const workspace = await this.workspace(workspaceId);
    const provider = await this.repo.findConfiguration(workspaceId, providerId);
    if (!provider?.isEnabled) throw fail();
    const snapshot = actor
      ? await this.passwordSnapshot(workspaceId, actor.userId, actor.password)
      : undefined;
    if (snapshot?.['mfa']?.isEnabled) throw fail();
    let proof: Awaited<ReturnType<WikisavvyOidcProtocol['start']>>;
    try {
      proof = await this.protocol.start(
        this.client(provider),
        workspace.callbackUrl,
      );
    } catch {
      throw fail();
    }
    const browserBinding = randomBytes(32).toString('base64url');
    const stateHash = hash(proof.state);
    const saved: SavedProof = {
      state: proof.state,
      nonce: proof.nonce,
      codeVerifier: proof.codeVerifier,
      redirectUri: proof.redirectUri,
      stateHash,
      workspaceId,
      providerId,
      revision: provider.revision,
      flow: actor ? 'link' : 'login',
      ...(actor
        ? {
            actor: {
              userId: actor.userId,
              sessionId: actor.sessionId,
              passwordHash: snapshot!.password,
            },
          }
        : {}),
    };
    await this.db.transaction().execute(async (trx) => {
      const freshWorkspace = await this.workspace(workspaceId, trx);
      if (freshWorkspace.callbackUrl !== proof.redirectUri) throw fail();
      if (actor) {
        const user = await this.lockedUser(workspaceId, actor.userId, trx);
        if (user.password !== snapshot!.password || user['mfa']?.isEnabled)
          throw fail();
        await this.liveSession(workspaceId, user.id, actor.sessionId, trx);
      }
      const current = await this.repo.lockConfiguration(
        workspaceId,
        providerId,
        trx,
      );
      if (!current?.isEnabled || current.revision !== provider.revision)
        throw fail();
      await this.repo.insertTransaction(
        {
          stateHash,
          workspaceId,
          providerId,
          issuer: provider.issuer,
          browserHash: hash(browserBinding),
          encryptedPayload: this.encryption.encrypt(
            JSON.stringify(saved),
            EncryptionPurpose.OIDC_PROOF,
          ),
          expiresAt: new Date(Date.now() + OIDC_FLOW_SECONDS * 1000),
        },
        trx,
      );
    });
    return { authorizationUrl: proof.authorizationUrl, browserBinding };
  }

  async complete(
    workspaceId: string,
    callback: URL,
    browserBinding: string,
  ): Promise<{ flow: 'link' | 'login'; authToken?: string }> {
    try {
      const workspace = await this.workspace(workspaceId);
      const state = callback.searchParams.get('state');
      if (
        !state ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(state) ||
        callback.searchParams.getAll('state').length !== 1 ||
        !browserBinding ||
        !/^[A-Za-z0-9_-]{43}$/.test(browserBinding) ||
        callback.origin + callback.pathname !== workspace.callbackUrl
      )
        throw fail();
      const claimed = await this.repo.claimTransaction(
        workspaceId,
        hash(state),
        hash(browserBinding),
      );
      if (!claimed) throw fail();
      const proof = JSON.parse(
        this.encryption.decrypt(
          claimed.encryptedPayload,
          EncryptionPurpose.OIDC_PROOF,
        ),
      ) as SavedProof;
      if (
        proof.stateHash !== hash(state) ||
        proof.state !== state ||
        proof.workspaceId !== workspaceId ||
        proof.providerId !== claimed.providerId ||
        proof.redirectUri !== workspace.callbackUrl ||
        !['login', 'link'].includes(proof.flow) ||
        (proof.flow === 'link' && !proof.actor)
      )
        throw fail();
      const provider = await this.repo.findConfiguration(
        workspaceId,
        proof.providerId,
      );
      if (
        !provider?.isEnabled ||
        provider.revision !== proof.revision ||
        provider.issuer !== claimed.issuer
      )
        throw fail();
      const identity = await this.protocol.complete(
        this.client(provider),
        callback,
        proof,
      );
      if (identity.issuer !== provider.issuer) throw fail();
      // Authentik's own MFA policy is the second factor; refuse SSO without it.
      if (!satisfiesRequiredMfa(identity.amr)) throw fail();
      const binding =
        proof.flow === 'login'
          ? await this.repo.findIdentity(
              workspaceId,
              identity.issuer,
              identity.subject,
            )
          : undefined;
      const userId = proof.actor?.userId ?? binding?.userId;
      if (
        !userId ||
        (proof.flow === 'login' && binding?.providerId !== provider.id)
      )
        throw fail();
      const result = await this.db.transaction().execute(async (trx) => {
        const freshWorkspace = await this.workspace(workspaceId, trx);
        if (freshWorkspace.callbackUrl !== proof.redirectUri) throw fail();
        const user = await this.lockedUser(workspaceId, userId, trx);
        if (user['mfa']?.isEnabled) throw fail();
        throwIfEmailNotVerified({
          isCloud: this.environment.isCloud(),
          emailVerifiedAt: user.emailVerifiedAt,
          email: user.email,
          workspaceId,
          appSecret: this.environment.getAppSecret(),
        });
        const current = await this.repo.lockConfiguration(
          workspaceId,
          provider.id,
          trx,
        );
        if (!current?.isEnabled || current.revision !== proof.revision)
          throw fail();
        if (proof.flow === 'link') {
          if (user.password !== proof.actor!.passwordHash) throw fail();
          await this.liveSession(
            workspaceId,
            user.id,
            proof.actor!.sessionId,
            trx,
          );
          await this.repo.insertIdentity(
            {
              workspaceId,
              providerId: provider.id,
              issuer: identity.issuer,
              subject: identity.subject,
              userId: user.id,
            },
            trx,
          );
          return { flow: 'link' as const };
        }
        const freshBinding = await this.repo.findIdentity(
          workspaceId,
          identity.issuer,
          identity.subject,
          trx,
        );
        if (
          freshBinding?.userId !== user.id ||
          freshBinding.providerId !== provider.id
        )
          throw fail();
        await this.users.updateLastLogin(user.id, workspaceId, trx);
        const authToken = await this.sessions.createSessionAndToken(user, trx);
        return { flow: 'login' as const, authToken };
      });
      this.audit.setActorId(userId);
      this.audit.log({
        event:
          proof.flow === 'link'
            ? AuditEvent.SSO_ACCOUNT_LINKED
            : AuditEvent.USER_LOGIN,
        resourceType: AuditResource.USER,
        resourceId: userId,
        metadata: { source: 'oidc', authProviderId: provider.id },
      });
      return result;
    } catch {
      throw fail();
    }
  }
}
