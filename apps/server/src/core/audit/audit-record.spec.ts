import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { prepareAuditRecord, publicAuditRecord } from './audit-record';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const resourceId = '33333333-3333-4333-8333-333333333333';
const context = { workspaceId, actorId, actorType: 'user' as const, ipAddress: '192.0.2.1' };
const payload = { event: AuditEvent.USER_ROLE_CHANGED, resourceType: AuditResource.USER, resourceId };

describe('Independent audit record boundary', () => {
  it('keeps trusted context and typed event/resource identifiers', () => {
    expect(prepareAuditRecord(payload, context)).toMatchObject({
      workspaceId, actorId, actorType: 'user', event: payload.event,
      resourceType: 'user', resourceId, ipAddress: '192.0.2.1',
    });
  });
  it('does not accept a payload-supplied workspace or actor', () => {
    const record = prepareAuditRecord({
      ...payload, workspaceId: resourceId, actorId: resourceId,
    } as any, context);
    expect(record.workspaceId).toBe(workspaceId);
    expect(record.actorId).toBe(actorId);
  });
  it('keeps bounded allowlisted changes and metadata, not raw content or credentials', () => {
    const record = prepareAuditRecord({
      ...payload,
      changes: {
        before: { role: 'member', password: 'synthetic-sensitive-value' },
        after: { role: 'admin', name: 'synthetic-sensitive-value', body: 'synthetic-sensitive-value' },
      },
      metadata: {
        source: 'password', count: 3, invitationId: resourceId,
        authorization: 'synthetic-sensitive-value',
        nested: { accessToken: 'synthetic-sensitive-value' },
        userAgent: 'synthetic-sensitive-value',
      },
    }, { ...context, userAgent: 'synthetic-sensitive-value' });
    expect(record.changes).toEqual({ before: { role: 'member' }, after: { role: 'admin' } });
    expect(record.metadata).toEqual({ source: 'password', count: 3, invitationId: resourceId });
    expect(record.userAgent).toBeNull();
    expect(JSON.stringify(record).includes('synthetic-sensitive-value')).toBe(false);
  });
  it('does not invoke getters or traverse arbitrary nested objects', () => {
    const getter = jest.fn(() => { throw new Error('must not execute'); });
    const metadata = { source: 'password' };
    Object.defineProperty(metadata, 'count', { enumerable: true, get: getter });
    Object.defineProperty(metadata, 'authorization', { enumerable: true, get: getter });
    expect(prepareAuditRecord({ ...payload, metadata }, context).metadata).toEqual({ source: 'password' });
    expect(getter).not.toHaveBeenCalled();
  });
  it('does not copy prototype properties', () => {
    const metadata = Object.create({ count: 5 });
    metadata.source = 'password';
    expect(prepareAuditRecord({ ...payload, metadata }, context).metadata).toBeNull();
  });
  it('does not mutate caller-owned structures or retain their arrays', () => {
    const ids = [resourceId];
    const metadata = { userIds: ids, source: 'invitation' };
    const before = JSON.stringify(metadata);
    const record = prepareAuditRecord({ ...payload, metadata }, context);
    expect(JSON.stringify(metadata)).toBe(before);
    ids.push(actorId);
    expect(record.metadata).toEqual({ userIds: [resourceId], source: 'invitation' });
  });
  it.each(['getter', 'iterator'])('does not execute an array %s from metadata', (kind) => {
    const execute = jest.fn(() => { throw new Error('must not execute'); });
    const userIds = [resourceId];
    if (kind === 'getter') {
      Object.defineProperty(userIds, '0', { get: execute });
    } else {
      Object.defineProperty(userIds, Symbol.iterator, { value: execute });
    }
    const record = prepareAuditRecord({ ...payload, metadata: { userIds } }, context);
    expect(execute).not.toHaveBeenCalled();
    expect(record.metadata).toEqual(kind === 'getter' ? null : { userIds: [resourceId] });
  });
  it('omits oversized arrays, invalid counts and unknown values', () => {
    const record = prepareAuditRecord({
      ...payload,
      metadata: { userIds: Array(101).fill(resourceId), count: Infinity, source: 'untrusted-free-form' },
      changes: { after: { role: 'untrusted-free-form', enabled: 'yes' } },
    }, context);
    expect(record.metadata).toBeNull();
    expect(record.changes).toBeNull();
  });
  it('does not persist an invalid IP address', () => {
    expect(prepareAuditRecord(payload, { ...context, ipAddress: 'not-an-ip' }).ipAddress).toBeNull();
  });
  it('supports explicit system context without inventing an actor', () => {
    expect(prepareAuditRecord(payload, { workspaceId, actorType: 'system' })).toMatchObject({
      workspaceId, actorId: null, actorType: 'system',
    });
  });
  it.each([
    {},
    { workspaceId: 'invalid' },
    { ...context, actorId: 'invalid' },
    { ...context, actorType: 'administrator' },
  ])('rejects invalid or missing scope without a workspace fallback', (value) => {
    expect(() => prepareAuditRecord(payload, value as any)).toThrow('Invalid audit record');
  });
  it.each([
    { ...payload, event: 'arbitrary-event' },
    { ...payload, resourceType: 'arbitrary-resource' },
    { ...payload, resourceId: 'invalid' },
    { ...payload, spaceId: 'invalid' },
    null,
  ])('rejects malformed event identifiers', (value) => {
    expect(() => prepareAuditRecord(value as any, context)).toThrow('Invalid audit record');
  });
  it('projects historical rows without arbitrary JSON, headers or unknown labels', () => {
    const row = {
      id: resourceId, createdAt: new Date(), actorId, resourceId, spaceId: null,
      event: 'synthetic-sensitive-value', actorType: 'synthetic-sensitive-value',
      resourceType: 'synthetic-sensitive-value', metadata: { password: 'synthetic-sensitive-value' },
      changes: { after: { accessToken: 'synthetic-sensitive-value' } },
      userAgent: 'synthetic-sensitive-value', ipAddress: '192.0.2.1',
    };
    const result = publicAuditRecord(row as any);
    expect(result).toMatchObject({ event: 'unknown', actorType: 'unknown', resourceType: 'unknown', actorId });
    expect(Object.keys(result).sort()).toEqual([
      'actorId', 'actorType', 'createdAt', 'event', 'id', 'resourceId', 'resourceType', 'spaceId',
    ]);
    expect(JSON.stringify(result).includes('synthetic-sensitive-value')).toBe(false);
  });
});
