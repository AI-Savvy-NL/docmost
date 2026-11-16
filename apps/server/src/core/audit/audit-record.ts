import { isUUID } from 'class-validator';
import { isIP } from 'node:net';
import type { Insertable, Selectable } from 'kysely';
import type { Audit } from '../../database/types/db';
import {
  AuditEvent,
  AuditResource,
  type AuditLogPayload,
} from '../../common/events/audit-events';
import {
  UserRole,
  SpaceRole,
  PagePermissionRole,
  PageAccessLevel,
} from '../../common/helpers/types/permission';
import type { AuditLogContext } from '../../integrations/audit/audit.service';

const events = new Set<string>(Object.values(AuditEvent));
const resources = new Set<string>(Object.values(AuditResource));
const actorTypes = new Set(['user', 'system', 'api_key']);
const roles = new Set<string>([
  ...Object.values(UserRole),
  ...Object.values(SpaceRole),
  ...Object.values(PagePermissionRole),
]);
const sources = new Set([
  'password', 'invitation', 'signup', 'manual', 'saml', 'oidc', 'ldap',
  'google', 'scim', 'api_key', 'oauth', 'import', 'export', 'system',
]);
const idFields = [
  'spaceId', 'pageId', 'parentPageId', 'userId', 'groupId', 'invitationId',
  'fromSpaceId', 'toSpaceId', 'templateId', 'authProviderId',
];
const booleanFields = [
  'enabled', 'disabled', 'archived', 'hasRestriction', 'isPublic', 'isDefault',
  'enforceMfa', 'enforceSso',
];
type SafeFields = Record<string, string | number | boolean | string[]>;

export class AuditRecordError extends Error {
  constructor(readonly reason: 'invalid-context' | 'invalid-payload') {
    super('Invalid audit record');
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function read(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && isUUID(value);
}

function optionalUuid(value: unknown, reason: 'invalid-context' | 'invalid-payload'): string | null {
  if (value == null) return null;
  if (!uuid(value)) throw new AuditRecordError(reason);
  return value;
}

function fields(value: unknown): SafeFields | null {
  if (!plain(value)) return null;
  const result: SafeFields = {};
  for (const key of idFields) {
    const candidate = read(value, key);
    if (uuid(candidate)) result[key] = candidate;
  }
  for (const key of ['userIds', 'groupIds', 'pageIds']) {
    const candidate = read(value, key);
    if (Array.isArray(candidate) && candidate.length <= 100) {
      const ids: string[] = [];
      for (let index = 0; index < candidate.length; index++) {
        const id = Object.getOwnPropertyDescriptor(candidate, String(index))?.value;
        if (!uuid(id)) break;
        ids.push(id);
      }
      if (ids.length === candidate.length) result[key] = ids;
    }
  }
  for (const key of booleanFields) {
    const candidate = read(value, key);
    if (typeof candidate === 'boolean') result[key] = candidate;
  }
  for (const key of ['count', 'pageCount', 'attachmentCount']) {
    const candidate = read(value, key);
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 && candidate <= 1_000_000_000) {
      result[key] = candidate;
    }
  }
  for (const key of ['role', 'defaultRole']) {
    const candidate = read(value, key);
    if (typeof candidate === 'string' && roles.has(candidate)) result[key] = candidate;
  }
  const accessLevel = read(value, 'accessLevel');
  if (accessLevel === PageAccessLevel.RESTRICTED) result.accessLevel = accessLevel;
  const source = read(value, 'source');
  if (typeof source === 'string' && sources.has(source)) result.source = source;
  return Object.keys(result).length ? result : null;
}

export function prepareAuditRecord(
  payload: AuditLogPayload,
  context: AuditLogContext,
): Insertable<Audit> {
  if (!plain(context)) throw new AuditRecordError('invalid-context');
  const workspaceId = read(context, 'workspaceId');
  const actorType = read(context, 'actorType') ?? 'user';
  if (!uuid(workspaceId) || typeof actorType !== 'string' || !actorTypes.has(actorType)) {
    throw new AuditRecordError('invalid-context');
  }
  const actorId = optionalUuid(read(context, 'actorId'), 'invalid-context');
  if (!plain(payload)) throw new AuditRecordError('invalid-payload');
  const event = read(payload, 'event');
  const resourceType = read(payload, 'resourceType');
  if (typeof event !== 'string' || !events.has(event) || typeof resourceType !== 'string' || !resources.has(resourceType)) {
    throw new AuditRecordError('invalid-payload');
  }
  const rawChanges = read(payload, 'changes');
  const changes: { before?: SafeFields; after?: SafeFields } = {};
  if (plain(rawChanges)) {
    for (const key of ['before', 'after'] as const) {
      const safe = fields(read(rawChanges, key));
      if (safe) changes[key] = safe;
    }
  }
  const ipAddress = read(context, 'ipAddress');
  return {
    workspaceId, actorId, actorType, event, resourceType,
    resourceId: optionalUuid(read(payload, 'resourceId'), 'invalid-payload'),
    spaceId: optionalUuid(read(payload, 'spaceId'), 'invalid-payload'),
    changes: Object.keys(changes).length ? changes : null,
    metadata: fields(read(payload, 'metadata')),
    ipAddress: typeof ipAddress === 'string' && isIP(ipAddress) ? ipAddress : null,
    userAgent: null,
  };
}

type AuditHistoryRow = Pick<Selectable<Audit>,
  'id' | 'createdAt' | 'event' | 'actorId' | 'actorType' | 'resourceType' | 'resourceId' | 'spaceId'>;

export function publicAuditRecord(row: AuditHistoryRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    event: events.has(row.event) ? row.event : 'unknown',
    actorId: row.actorId,
    actorType: actorTypes.has(row.actorType) ? row.actorType : 'unknown',
    resourceType: resources.has(row.resourceType) ? row.resourceType : 'unknown',
    resourceId: row.resourceId,
    spaceId: row.spaceId,
  };
}
