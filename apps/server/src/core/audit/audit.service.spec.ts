import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_CONTEXT_KEY } from '../../common/middlewares/audit-context.middleware';
import { WikisavvyAuditService } from './audit.service';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const otherWorkspace = '33333333-3333-4333-8333-333333333333';
const payload = { event: AuditEvent.USER_LOGIN, resourceType: AuditResource.USER, resourceId: actorId };
const context = { workspaceId, actorId, actorType: 'user' as const };

describe('Independent non-blocking audit capture', () => {
  let cls: ClsService;
  let repository: any;
  let service: WikisavvyAuditService;
  function within<T>(scope: unknown, callback: () => T): T {
    return cls.run(() => {
      cls.set(AUDIT_CONTEXT_KEY, scope);
      return callback();
    });
  }
  beforeEach(() => {
    cls = new ClsService(new AsyncLocalStorage());
    repository = { insert: jest.fn().mockResolvedValue(undefined), list: jest.fn().mockResolvedValue({ items: [], meta: {} }) };
    service = new WikisavvyAuditService(repository, cls);
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());
  it('captures the active request scope without licensing dependencies', async () => {
    await within(context, () => service.log(payload));
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actorId }));
    expect(service.getStatus().recorded).toBe(1);
  });
  it('keeps concurrent contexts and actor setters isolated', async () => {
    await Promise.all([
      within({ workspaceId, actorId: null, actorType: 'user' }, async () => {
        service.setActorId(actorId);
        await Promise.resolve();
        await service.log(payload);
      }),
      within({ workspaceId: otherWorkspace, actorId: null, actorType: 'user' }, async () => {
        service.setActorType('system');
        await Promise.resolve();
        await service.log(payload);
      }),
    ]);
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, actorId, actorType: 'user' }));
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: otherWorkspace, actorId: null, actorType: 'system' }));
  });
  it('uses explicit job context instead of ambient request context', async () => {
    await within(context, () =>
      service.logWithContext(payload, { workspaceId: otherWorkspace, actorType: 'system' }));
    expect(repository.insert).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: otherWorkspace, actorId: null }));
  });
  it('does not guess a workspace when context is absent', async () => {
    await expect(service.log(payload)).resolves.toBeUndefined();
    expect(repository.insert).not.toHaveBeenCalled();
    expect(service.getStatus().rejected).toBe(1);
  });
  it('never propagates or logs credential-bearing persistence errors', async () => {
    repository.insert.mockRejectedValue(new Error('synthetic-sensitive-details'));
    await expect(service.logWithContext(payload, context)).resolves.toBeUndefined();
    expect(service.getStatus()).toMatchObject({ failed: 1, recorded: 0, scope: 'server-process' });
    expect(JSON.stringify(jest.mocked(Logger.prototype.error).mock.calls).includes('synthetic-sensitive-details')).toBe(false);
  });
  it('bounds repeated alerts while counting every failed write', async () => {
    repository.insert.mockRejectedValue(new Error('synthetic-sensitive-details'));
    for (let index = 0; index < 3; index++) await service.logWithContext(payload, context);
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
    expect(service.getStatus().failed).toBe(3);
  });
  it('keeps business operations non-blocking even if the alert sink throws', async () => {
    repository.insert.mockRejectedValue(new Error('synthetic-sensitive-details'));
    jest.mocked(Logger.prototype.error).mockImplementation(() => { throw new Error('alert sink unavailable'); });
    await expect(service.logWithContext(payload, context)).resolves.toBeUndefined();
    expect(service.getStatus().failed).toBe(1);
  });
  it('rejects malformed records without writing them', async () => {
    await expect(service.logWithContext({ ...payload, event: 'untrusted' } as any, context)).resolves.toBeUndefined();
    expect(repository.insert).not.toHaveBeenCalled();
    expect(service.getStatus().rejected).toBe(1);
  });
  it('does not let one invalid batch record discard valid records', async () => {
    await service.logBatchWithContext([payload, { ...payload, event: 'untrusted' } as any, payload], context);
    expect(repository.insert).toHaveBeenCalledTimes(2);
    expect(service.getStatus()).toMatchObject({ recorded: 2, rejected: 1 });
  });
  it('does not let callers mutate process-local counters', () => {
    const status = service.getStatus();
    status.failed = 99;
    expect(service.getStatus().failed).toBe(0);
  });
  it('does not silently pretend retention automation exists', () => {
    expect(() => service.updateRetention(workspaceId, 1)).toThrow('not implemented');
    expect(repository.insert).not.toHaveBeenCalled();
  });
  it('masks read failures without exposing database diagnostics', async () => {
    repository.list.mockRejectedValue(new Error('synthetic-sensitive-details'));
    await expect(service.list(workspaceId, { limit: 50 })).rejects.toThrow('Audit history is unavailable');
  });
  it('does not expose another workspace activity through capture counters', async () => {
    await service.logWithContext(payload, { ...context, workspaceId: otherWorkspace });
    const first = await service.list(workspaceId, { limit: 50 });
    const second = await service.list(otherWorkspace, { limit: 50 });
    expect(first.captureStatus).toMatchObject({ recorded: 0, rejected: 0, failed: 0 });
    expect(second.captureStatus.recorded).toBe(1);
  });
  it('isolates rejected, failed and last-failure counters by workspace', async () => {
    await service.logWithContext({ ...payload, event: 'invalid' } as any, { ...context, workspaceId: otherWorkspace });
    repository.insert.mockRejectedValue(new Error('synthetic-sensitive-details'));
    await service.logWithContext(payload, { ...context, workspaceId: otherWorkspace });
    const first = await service.list(workspaceId, { limit: 50 });
    const second = await service.list(otherWorkspace, { limit: 50 });
    expect(first.captureStatus).toMatchObject({ rejected: 0, failed: 0, lastFailureAt: null });
    expect(second.captureStatus).toMatchObject({ rejected: 1, failed: 1, lastFailureAt: expect.any(String) });
  });
  it('does not attribute unscoped rejections or invoke workspace getters', async () => {
    const getter = jest.fn(() => { throw new Error('must not execute'); });
    const invalid = Object.defineProperty({}, 'workspaceId', { get: getter });
    await expect(service.logWithContext(payload, invalid as any)).resolves.toBeUndefined();
    await expect(service.logBatchWithContext(null, invalid as any)).resolves.toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(service.getStatus().rejected).toBe(2);
    const page = await service.list(workspaceId, { limit: 50 });
    expect(page.captureStatus).toMatchObject({ recorded: 0, rejected: 0, failed: 0, lastFailureAt: null });
  });
  it('attributes an invalid batch only to its workspace', async () => {
    await service.logBatchWithContext(null, { ...context, workspaceId: otherWorkspace });
    expect((await service.list(workspaceId, { limit: 50 })).captureStatus.rejected).toBe(0);
    expect((await service.list(otherWorkspace, { limit: 50 })).captureStatus.rejected).toBe(1);
  });
});
