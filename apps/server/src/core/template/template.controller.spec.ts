import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { StorageService } from '../../integrations/storage/storage.service';
import { TemplateService } from './template.service';
import { TemplateController } from './template.controller';

jest.mock('../page/services/page.service', () => ({ PageService: class {} }));

describe('Template HTTP boundary', () => {
  let app: NestFastifyApplication;
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const id = randomUUID();
  const templates = {
    list: jest.fn().mockResolvedValue({ items: [], meta: {} }),
    info: jest.fn().mockResolvedValue({ id }),
    create: jest.fn().mockResolvedValue({ id }),
    update: jest.fn().mockResolvedValue({ id }),
    remove: jest.fn().mockResolvedValue(undefined),
    use: jest.fn().mockResolvedValue({ id }),
    file: jest.fn(),
  };
  const storage = { readStream: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TemplateController],
      providers: [
        { provide: TemplateService, useValue: templates },
        { provide: StorageService, useValue: storage },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: any) {
          const request = context.switchToHttp().getRequest();
          if (!request.headers['x-fixture-session'])
            throw new UnauthorizedException();
          request.user = {
            user: { id: userId, workspaceId },
            workspace: {
              id: request.headers['x-fixture-workspace'] ?? workspaceId,
            },
          };
          if (request.headers['x-fixture-session'] !== 'missing-persistence') {
            request.raw.sessionId = 'local-fixture';
          }
          return true;
        },
      })
      .compile();
    app = module.createNestApplication(new FastifyAdapter(), { logger: false });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });
  const request = (
    url: string,
    payload: any = {},
    headers: any = { 'x-fixture-session': 'valid' },
  ) => app.inject({ method: 'POST', url, payload, headers });

  it.each(['', '/info', '/create', '/update', '/delete', '/use'])(
    'protects POST /templates%s with the authentication guard',
    async (suffix) => {
      expect((await request(`/templates${suffix}`, {}, {})).statusCode).toBe(
        401,
      );
    },
  );
  it('rejects a mismatched domain workspace before calling the service', async () => {
    const response = await request(
      '/templates/info',
      { templateId: id },
      {
        'x-fixture-session': 'valid',
        'x-fixture-workspace': randomUUID(),
      },
    );
    expect(response.statusCode).toBe(403);
    expect(templates.info).not.toHaveBeenCalled();
  });
  it('requires the persisted interactive session', async () => {
    expect(
      (
        await request(
          '/templates/create',
          {},
          { 'x-fixture-session': 'missing-persistence' },
        )
      ).statusCode,
    ).toBe(403);
    expect(templates.create).not.toHaveBeenCalled();
  });
  it('rejects malformed source identifiers and non-boolean restricted-source confirmation', async () => {
    expect(
      (await request('/templates/create', { sourcePageId: 'not-a-uuid' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await request('/templates/create', { confirmRestrictedSource: 'true' }))
        .statusCode,
    ).toBe(400);
    expect(templates.create).not.toHaveBeenCalled();
  });
  it('does not accept caller-supplied ownership or workspace fields', async () => {
    const response = await request('/templates/create', {
      title: 'Safe',
      creatorId: randomUUID(),
      workspaceId: randomUUID(),
      spaceId: randomUUID(),
    });
    expect(response.statusCode).toBe(200);
    expect(templates.create).toHaveBeenCalledWith(
      { id: userId, workspaceId },
      { title: 'Safe' },
    );
  });
  it('rejects an invalid target space and non-document content payloads', async () => {
    expect(
      (await request('/templates/use', { templateId: id, spaceId: '../' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await request('/templates/update', {
          templateId: id,
          content: '<script>',
        })
      ).statusCode,
    ).toBe(400);
  });
  it('guards file downloads and rejects invalid identifiers', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/templates/files/${id}/image.png`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/templates/files/invalid/image.png',
          headers: { 'x-fixture-session': 'valid' },
        })
      ).statusCode,
    ).toBe(400);
    expect(templates.file).not.toHaveBeenCalled();
  });
  it('serves a template file only after tenant authorization with restrictive response headers', async () => {
    templates.file.mockResolvedValue({
      filePath: 'fixture/image.png',
      fileName: 'image.png',
      mimeType: 'image/png',
    });
    storage.readStream.mockResolvedValue(
      Readable.from(Buffer.from('fixture bytes')),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/templates/files/${id}/image.png`,
      headers: { 'x-fixture-session': 'valid' },
    });
    expect(response.statusCode).toBe(200);
    expect(templates.file).toHaveBeenCalledWith(
      { id: userId, workspaceId },
      id,
    );
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe('sandbox');
  });
  it('does not serve HTML inline', async () => {
    templates.file.mockResolvedValue({
      filePath: 'fixture/file.html',
      fileName: 'file.html',
      mimeType: 'text/html',
    });
    storage.readStream.mockResolvedValue(
      Readable.from(Buffer.from('<script>')),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/templates/files/${id}/file.html`,
      headers: { 'x-fixture-session': 'valid' },
    });
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toMatch(/^attachment;/);
  });
});
