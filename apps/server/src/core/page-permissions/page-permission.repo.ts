import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectKysely } from 'nestjs-kysely';
import { sql } from 'kysely';
import type {
  KyselyDB,
  KyselyTransaction,
} from '../../database/types/kysely.types';
import { PagePermissionRepo } from '../../database/repos/page/page-permission.repo';
import type { Page } from '../../database/types/entity.types';
import type {
  PermissionGrant,
  PermissionPrincipal,
  PermissionSnapshot,
} from './page-permission.types';

type LineageRow = {
  id: string;
  parentPageId: string | null;
  workspaceId: string;
  spaceId: string;
  deletedAt: Date | null;
  depth: number;
  accessId: string | null;
  version: string;
};

@Injectable()
export class WikisavvyPagePermissionRepo {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly permissions: PagePermissionRepo,
  ) {}

  transaction<T>(callback: (trx: KyselyTransaction) => Promise<T>) {
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(callback);
  }

  async lockWorkspace(workspaceId: string, trx: KyselyTransaction) {
    const workspace = await trx
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!workspace) throw new NotFoundException('Workspace not found');
  }

  async lockPrincipals(page: Page, trx: KyselyTransaction) {
    await trx
      .selectFrom('spaces')
      .select('id')
      .where('id', '=', page.spaceId)
      .where('workspaceId', '=', page.workspaceId)
      .forShare()
      .execute();
    await trx
      .selectFrom('groups')
      .select('id')
      .where('workspaceId', '=', page.workspaceId)
      .orderBy('id')
      .forShare()
      .execute();
    await trx
      .selectFrom('users')
      .select('id')
      .where('workspaceId', '=', page.workspaceId)
      .orderBy('id')
      .forShare()
      .execute();
    await trx
      .selectFrom('spaceMembers')
      .select('id')
      .where('spaceId', '=', page.spaceId)
      .orderBy('id')
      .forShare()
      .execute();
    await sql`
      SELECT gu.user_id FROM group_users gu
      JOIN groups g ON g.id = gu.group_id
      WHERE g.workspace_id = ${page.workspaceId}::uuid
      ORDER BY gu.group_id, gu.user_id
      FOR SHARE OF gu
    `.execute(trx);
  }

  async snapshot(
    pageId: string,
    trx: KyselyTransaction,
  ): Promise<PermissionSnapshot> {
    const { rows } = await sql<LineageRow>`
      WITH RECURSIVE lineage AS (
        SELECT p.id, p.parent_page_id, p.workspace_id, p.space_id, p.deleted_at, 0 AS depth
        FROM pages p WHERE p.id = ${pageId}::uuid
        UNION ALL
        SELECT p.id, p.parent_page_id, p.workspace_id, p.space_id, p.deleted_at, l.depth + 1
        FROM pages p JOIN lineage l ON l.parent_page_id = p.id
      )
      SELECT l.*, pa.id AS access_id, coalesce(r.version::text, '0') AS version
      FROM lineage l LEFT JOIN page_access pa ON pa.page_id = l.id
      LEFT JOIN wikisavvy_page_permission_revisions r ON r.page_id = l.id
      ORDER BY l.depth
    `.execute(trx);
    if (!rows.length) throw new NotFoundException('Page not found');
    const accessIds = rows.flatMap((row) =>
      row.accessId ? [row.accessId] : [],
    );
    const grants = accessIds.length
      ? await trx
          .selectFrom('pagePermissions')
          .select(['id', 'pageAccessId', 'userId', 'groupId', 'role'])
          .where('pageAccessId', 'in', accessIds)
          .orderBy('id')
          .execute()
      : [];
    const direct = grants.filter(
      (grant) => grant.pageAccessId === rows[0].accessId,
    );
    return {
      pageId,
      revision: createHash('sha256')
        .update(JSON.stringify({ lineage: rows, grants }))
        .digest('hex'),
      hasDirectRestriction: Boolean(rows[0].accessId),
      inheritedPageId:
        rows.find((row) => row.depth > 0 && row.accessId)?.id ?? null,
      grants: direct.map((grant) => ({
        type: grant.userId ? 'user' : 'group',
        id: grant.userId ?? grant.groupId,
        role: grant.role as PermissionGrant['role'],
      })),
    };
  }

  async validatePrincipals(
    grants: PermissionGrant[],
    page: Page,
    trx: KyselyTransaction,
  ) {
    for (const grant of grants) {
      if (grant.type === 'group') {
        const group = await trx
          .selectFrom('groups')
          .select('id')
          .where('id', '=', grant.id)
          .where('workspaceId', '=', page.workspaceId)
          .executeTakeFirst();
        if (!group)
          throw new NotFoundException('Permission principal not found');
        continue;
      }
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', grant.id)
        .where('workspaceId', '=', page.workspaceId)
        .where('deletedAt', 'is', null)
        .where('deactivatedAt', 'is', null)
        .executeTakeFirst();
      if (!user) throw new NotFoundException('Permission principal not found');
      const { rows } = await sql<{ eligible: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM space_members sm
          WHERE sm.space_id = ${page.spaceId}::uuid AND sm.role IN ('reader','writer','admin')
          AND (sm.user_id = ${grant.id}::uuid OR sm.group_id IN (
            SELECT gu.group_id FROM group_users gu JOIN groups g ON g.id = gu.group_id
            WHERE gu.user_id = ${grant.id}::uuid AND g.workspace_id = ${page.workspaceId}::uuid
          ))
        ) AS eligible
      `.execute(trx);
      if (!rows[0].eligible)
        throw new NotFoundException('Permission principal not found');
    }
  }

  async describeGrants(
    grants: PermissionGrant[],
    workspaceId: string,
    trx: KyselyTransaction,
  ) {
    return Promise.all(
      grants.map(async (grant) => {
        if (grant.type === 'user') {
          const user = await trx
            .selectFrom('users')
            .select(['name', 'email'])
            .where('id', '=', grant.id)
            .where('workspaceId', '=', workspaceId)
            .executeTakeFirst();
          return {
            ...grant,
            name: user?.name || user?.email || 'Unavailable user',
            email: user?.email ?? null,
          };
        }
        const group = await trx
          .selectFrom('groups')
          .select('name')
          .where('id', '=', grant.id)
          .where('workspaceId', '=', workspaceId)
          .executeTakeFirst();
        return {
          ...grant,
          name: group?.name || 'Unavailable group',
          email: null,
        };
      }),
    );
  }

  async principals(
    page: Page,
    query: string,
    trx: KyselyTransaction,
  ): Promise<PermissionPrincipal[]> {
    const { rows } = await sql<PermissionPrincipal>`
      SELECT * FROM (
        SELECT 'user' AS type, u.id, coalesce(nullif(u.name, ''), u.email) AS name, u.email
        FROM users u WHERE u.workspace_id = ${page.workspaceId}::uuid
          AND u.deleted_at IS NULL AND u.deactivated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM space_members sm WHERE sm.space_id = ${page.spaceId}::uuid
              AND sm.role IN ('reader', 'writer', 'admin')
              AND (sm.user_id = u.id OR sm.group_id IN (
                SELECT gu.group_id FROM group_users gu JOIN groups g ON g.id = gu.group_id
                WHERE gu.user_id = u.id AND g.workspace_id = ${page.workspaceId}::uuid
              ))
          )
        UNION ALL
        SELECT 'group' AS type, g.id, g.name, NULL AS email
        FROM groups g WHERE g.workspace_id = ${page.workspaceId}::uuid
      ) principals
      WHERE name ILIKE ${`%${query}%`} OR email ILIKE ${`%${query}%`}
      ORDER BY name, type, id LIMIT 50
    `.execute(trx);
    return rows;
  }

  async replace(
    page: Page,
    actorId: string,
    grants: PermissionGrant[],
    trx: KyselyTransaction,
  ) {
    let access = await this.permissions.findPageAccessByPageId(page.id, trx);
    if (!access) {
      access = await this.permissions.insertPageAccess(
        {
          pageId: page.id,
          workspaceId: page.workspaceId,
          spaceId: page.spaceId,
          accessLevel: 'restricted',
          creatorId: actorId,
        },
        trx,
      );
    } else {
      await trx
        .updateTable('pageAccess')
        .set({ updatedAt: new Date() })
        .where('id', '=', access.id)
        .execute();
      await trx
        .deleteFrom('pagePermissions')
        .where('pageAccessId', '=', access.id)
        .execute();
    }
    await this.permissions.insertPagePermissions(
      grants.map((grant) => ({
        pageAccessId: access.id,
        role: grant.role,
        addedById: actorId,
        ...(grant.type === 'user'
          ? { userId: grant.id }
          : { groupId: grant.id }),
      })),
      trx,
    );
    await this.bump(page.id, trx);
  }

  async remove(pageId: string, trx: KyselyTransaction) {
    await this.permissions.deletePageAccess(pageId, trx);
    await this.bump(pageId, trx);
  }

  private async bump(pageId: string, trx: KyselyTransaction) {
    await trx
      .insertInto('wikisavvyPagePermissionRevisions')
      .values({ pageId, version: '1' })
      .onConflict((conflict) =>
        conflict.column('pageId').doUpdateSet({
          version: sql`wikisavvy_page_permission_revisions.version + 1`,
        }),
      )
      .execute();
  }

  async assertSurvivingWriters(page: Page, trx: KyselyTransaction) {
    const { rows: restricted } = await sql<{
      id: string;
      accessId: string | null;
      spaceId: string;
      workspaceId: string;
    }>`
      WITH RECURSIVE affected AS (
        SELECT id, space_id, workspace_id FROM pages WHERE id = ${page.id}::uuid
        UNION ALL
        SELECT p.id, p.space_id, p.workspace_id FROM pages p
        JOIN affected a ON p.parent_page_id = a.id
      ),
      lineage AS (
        SELECT id, parent_page_id, 0 AS depth FROM pages WHERE id = ${page.id}::uuid
        UNION ALL
        SELECT p.id, p.parent_page_id, l.depth + 1
        FROM pages p JOIN lineage l ON l.parent_page_id = p.id
      )
      SELECT a.*, pa.id AS access_id FROM affected a JOIN page_access pa ON pa.page_id = a.id
      UNION
      SELECT p.id, p.space_id, p.workspace_id, (
        SELECT pa.id FROM lineage l JOIN page_access pa ON pa.page_id = l.id
        ORDER BY l.depth LIMIT 1
      ) AS access_id FROM pages p WHERE p.id = ${page.id}::uuid
      ORDER BY id
    `.execute(trx);
    for (const restrictedPage of restricted) {
      if (
        restrictedPage.workspaceId !== page.workspaceId ||
        restrictedPage.spaceId !== page.spaceId
      ) {
        throw new ConflictException(
          'Page hierarchy changed; refresh and retry',
        );
      }
      const { rows: candidates } = await sql<{ id: string }>`
        SELECT u.id FROM users u
        WHERE u.workspace_id = ${page.workspaceId}::uuid
          AND u.deleted_at IS NULL AND u.deactivated_at IS NULL
          AND (${restrictedPage.accessId}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM page_permissions pp
            WHERE pp.page_access_id = ${restrictedPage.accessId}::uuid AND pp.role = 'writer'
              AND (pp.user_id = u.id OR pp.group_id IN (
                SELECT gu.group_id FROM group_users gu JOIN groups g ON g.id = gu.group_id
                WHERE gu.user_id = u.id AND g.workspace_id = ${page.workspaceId}::uuid
              ))
          ))
          AND EXISTS (
            SELECT 1 FROM space_members sm
            WHERE sm.space_id = ${page.spaceId}::uuid AND sm.role IN ('reader','writer','admin')
              AND (${restrictedPage.accessId}::uuid IS NOT NULL OR sm.role IN ('writer','admin'))
              AND (sm.user_id = u.id OR sm.group_id IN (
                SELECT gu.group_id FROM group_users gu JOIN groups g ON g.id = gu.group_id
                WHERE gu.user_id = u.id AND g.workspace_id = ${page.workspaceId}::uuid
              ))
          )
        ORDER BY u.id
      `.execute(trx);
      let hasWriter = false;
      for (const candidate of candidates) {
        const access = await this.permissions.canUserEditPage(
          candidate.id,
          restrictedPage.id,
          {
            trx,
            skipCache: true,
          },
        );
        if (
          access.hasAnyRestriction === Boolean(restrictedPage.accessId) &&
          access.canAccess &&
          access.canEdit
        ) {
          hasWriter = true;
          break;
        }
      }
      if (!hasWriter)
        throw new ConflictException(
          'Change would leave a page without an accessible writer',
        );
    }
  }
}
