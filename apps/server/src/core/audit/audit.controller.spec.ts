import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { REQUIRE_SESSION_AUTH_KEY } from '../../common/decorators/require-session-auth.decorator';
import { JwtType } from '../auth/dto/jwt-payload';
import { UserRole } from '../../common/helpers/types/permission';
import { AuditHistoryDto, WikisavvyAuditController } from './audit.controller';

describe('Independent audit history boundary', () => {
  const workspace = { id: '11111111-1111-4111-8111-111111111111' } as any;
  const owner = { id: '22222222-2222-4222-8222-222222222222', role: UserRole.OWNER, workspaceId: workspace.id } as any;
  const sessionRequest = { raw: { sessionId: '33333333-3333-4333-8333-333333333333' } } as any;
  let service: any;
  let controller: WikisavvyAuditController;
  beforeEach(() => {
    service = { list: jest.fn().mockResolvedValue({ items: [] }) };
    controller = new WikisavvyAuditController(service);
  });
  it('uses authenticated workspace context for owner reads', async () => {
    const dto = new AuditHistoryDto();
    await controller.list(owner, workspace, dto, sessionRequest);
    expect(service.list).toHaveBeenCalledWith(workspace.id, dto);
  });
  it.each([UserRole.ADMIN, UserRole.MEMBER])('rejects audit access for %s', async (role) => {
    await expect(controller.list({ ...owner, role }, workspace, new AuditHistoryDto(), sessionRequest)).rejects.toThrow();
    expect(service.list).not.toHaveBeenCalled();
  });
  it('rejects cross-workspace owner context', async () => {
    await expect(controller.list({ ...owner, workspaceId: 'other' }, workspace, new AuditHistoryDto(), sessionRequest)).rejects.toThrow();
    expect(service.list).not.toHaveBeenCalled();
  });
  it('rejects owner access without a validated persisted session', async () => {
    await expect(controller.list(owner, workspace, new AuditHistoryDto())).rejects.toThrow();
    expect(service.list).not.toHaveBeenCalled();
  });
  it('requires an interactive authenticated session, not API/OAuth credentials', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WikisavvyAuditController)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata(REQUIRE_SESSION_AUTH_KEY, WikisavvyAuditController)).toBe(true);
    const guard = new JwtAuthGuard(new Reflector(), {} as any);
    const context = { getClass: () => WikisavvyAuditController, getHandler: () => WikisavvyAuditController.prototype.list } as any;
    for (const authType of [JwtType.API_KEY, JwtType.OAUTH_ACCESS]) {
      expect(() => guard.handleRequest(null, { user: owner, workspace, authType }, null, context)).toThrow('interactive user session');
    }
    expect(() => guard.handleRequest(null, null, null, context)).toThrow();
  });
  it.each([0, -1, 101, 1.5])('rejects invalid page limit %s', async (limit) => {
    const dto = plainToInstance(AuditHistoryDto, { limit });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
  it('accepts bounded defaults and rejects oversized cursor input', async () => {
    expect(await validate(new AuditHistoryDto())).toEqual([]);
    expect((await validate(plainToInstance(AuditHistoryDto, { cursor: 'x'.repeat(513) }))).length).toBeGreaterThan(0);
  });
});
