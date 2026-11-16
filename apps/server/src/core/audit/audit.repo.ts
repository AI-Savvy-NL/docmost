import { BadRequestException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable } from 'kysely';
import type { Audit } from '../../database/types/db';
import { KyselyDB } from '../../database/types/kysely.types';
import { executeWithCursorPagination } from '../../database/pagination/cursor-pagination';

export type AuditListOptions = {
  limit: number;
  cursor?: string;
  beforeCursor?: string;
};

@Injectable()
export class WikisavvyAuditRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insert(record: Insertable<Audit>): Promise<void> {
    await this.db.insertInto('audit').values(record).execute();
  }

  list(workspaceId: string, options: AuditListOptions) {
    if (!isUUID(workspaceId) || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new BadRequestException('Invalid audit history request');
    }
    for (const cursor of [options.cursor, options.beforeCursor]) {
      if (cursor != null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 512)) {
        throw new BadRequestException('Invalid audit history cursor');
      }
    }
    if (options.cursor && options.beforeCursor) throw new BadRequestException('Use one audit history cursor');
    const query = this.db.selectFrom('audit')
      .select(['id', 'createdAt', 'event', 'actorId', 'actorType', 'resourceType', 'resourceId', 'spaceId'])
      .where('workspaceId', '=', workspaceId);
    return executeWithCursorPagination(query, {
      perPage: options.limit,
      cursor: options.cursor,
      beforeCursor: options.beforeCursor,
      fields: [{ expression: 'id', direction: 'desc' }],
      parseCursor: (value) => {
        if (!isUUID(value.id)) throw new BadRequestException('Invalid audit history cursor');
        return { id: value.id };
      },
    });
  }
}
