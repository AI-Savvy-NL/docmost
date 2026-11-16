import {
  BadRequestException,
  Injectable,
  Logger,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { isUUID } from 'class-validator';
import type { ActorType, AuditLogPayload } from '../../common/events/audit-events';
import { AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import type { AuditLogContext, IAuditService } from '../../integrations/audit/audit.service';
import { AuditRecordError, prepareAuditRecord, publicAuditRecord } from './audit-record';
import { WikisavvyAuditRepo, type AuditListOptions } from './audit.repo';

@Injectable()
export class WikisavvyAuditService implements IAuditService {
  private readonly logger = new Logger(WikisavvyAuditService.name);
  private readonly alerts = new Map<string, number>();
  private readonly status = {
    scope: 'server-process' as const,
    startedAt: new Date().toISOString(),
    recorded: 0,
    rejected: 0,
    failed: 0,
    lastFailureAt: null as string | null,
  };
  private readonly workspaceStatus = new Map<string, typeof this.status>();

  constructor(
    private readonly repository: WikisavvyAuditRepo,
    private readonly cls: ClsService,
  ) {}

  getStatus(workspaceId?: string) {
    if (workspaceId === undefined) return { ...this.status };
    return {
      scope: this.status.scope,
      startedAt: this.status.startedAt,
      recorded: 0,
      rejected: 0,
      failed: 0,
      lastFailureAt: null as string | null,
      ...this.workspaceStatus.get(workspaceId.toLowerCase()),
    };
  }

  private contextWorkspace(context: unknown): string | undefined {
    try {
      if (!context || typeof context !== 'object') return;
      const prototype = Object.getPrototypeOf(context);
      if (prototype !== null && prototype !== Object.prototype) return;
      const id = Object.getOwnPropertyDescriptor(context, 'workspaceId')?.value;
      if (typeof id === 'string' && id.length === 36 && isUUID(id)) return id;
    } catch {
      return;
    }
  }

  private count(kind: 'recorded' | 'rejected' | 'failed', workspaceId?: string) {
    const lastFailureAt = kind === 'recorded' ? null : new Date().toISOString();
    this.status[kind]++;
    if (lastFailureAt) this.status.lastFailureAt = lastFailureAt;
    if (!workspaceId) return;
    const status = this.getStatus(workspaceId);
    status[kind]++;
    if (lastFailureAt) status.lastFailureAt = lastFailureAt;
    this.workspaceStatus.set(workspaceId.toLowerCase(), status);
  }

  private alert(reason: 'invalid-context' | 'invalid-payload' | 'persistence-error' | 'read-error') {
    const now = Date.now();
    const previous = this.alerts.get(reason);
    if (previous !== undefined && now - previous < 30_000) return;
    this.alerts.set(reason, now);
    try {
      if (reason === 'persistence-error') {
        this.logger.error('Audit persistence failed; some events may be missing');
      } else {
        this.logger.warn(`Audit operation failed (${reason})`);
      }
    } catch {
      // Alert transport failures must not change the business operation's outcome.
    }
  }

  private reject(reason: 'invalid-context' | 'invalid-payload', context: unknown) {
    this.count('rejected', this.contextWorkspace(context));
    this.alert(reason);
  }

  async log(payload: AuditLogPayload): Promise<void> {
    await this.logWithContext(payload, this.cls.get<AuditLogContext>(AUDIT_CONTEXT_KEY));
  }

  async logWithContext(payload: AuditLogPayload, context: AuditLogContext): Promise<void> {
    let record: ReturnType<typeof prepareAuditRecord>;
    try {
      record = prepareAuditRecord(payload, context);
    } catch (error) {
      this.reject(error instanceof AuditRecordError ? error.reason : 'invalid-payload', context);
      return;
    }
    try {
      await this.repository.insert(record);
      this.count('recorded', record.workspaceId);
    } catch {
      this.count('failed', record.workspaceId);
      this.alert('persistence-error');
    }
  }

  async logBatchWithContext(payloads: AuditLogPayload[], context: AuditLogContext): Promise<void> {
    if (!Array.isArray(payloads)) {
      this.reject('invalid-payload', context);
      return;
    }
    for (let index = 0; index < payloads.length; index++) {
      await this.logWithContext(Object.getOwnPropertyDescriptor(payloads, String(index))?.value, context);
    }
  }

  setActorId(actorId: string): void {
    const context = this.cls.get<AuditLogContext>(AUDIT_CONTEXT_KEY);
    if (context && this.cls.isActive()) {
      this.cls.set(AUDIT_CONTEXT_KEY, { ...context, actorId });
    }
  }

  setActorType(actorType: ActorType): void {
    const context = this.cls.get<AuditLogContext>(AUDIT_CONTEXT_KEY);
    if (context && this.cls.isActive()) {
      this.cls.set(AUDIT_CONTEXT_KEY, { ...context, actorType });
    }
  }

  updateRetention(_workspaceId: string, _retentionDays: number): void {
    throw new NotImplementedException('Audit retention is not implemented in this build');
  }

  async list(workspaceId: string, options: AuditListOptions) {
    try {
      const page = await this.repository.list(workspaceId, options);
      return {
        items: page.items.map(publicAuditRecord),
        meta: page.meta,
        captureStatus: this.getStatus(workspaceId),
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.alert('read-error');
      throw new ServiceUnavailableException('Audit history is unavailable');
    }
  }
}
