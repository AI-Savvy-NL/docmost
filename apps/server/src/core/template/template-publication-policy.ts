import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'kysely';
import { Page } from '@docmost/db/types/entity.types';
import { KyselyTransaction } from '@docmost/db/types/kysely.types';
import { UserRole } from '../../common/helpers/types/permission';

export type TemplateSourceSnapshot = Pick<
  Page,
  | 'id'
  | 'workspaceId'
  | 'spaceId'
  | 'title'
  | 'icon'
  | 'content'
  | 'textContent'
>;

@Injectable()
export class TemplatePublicationPolicy {
  async assertCanPublish(
    actor: { id: string; workspaceId: string },
    sourcePageId: string,
    confirmRestrictedSource: boolean,
    trx: KyselyTransaction,
  ): Promise<TemplateSourceSnapshot> {
    // Read audience, actor role and content in one snapshot; callers must persist
    // the returned content in this transaction, never reread a client-supplied body.
    const { rows } = await sql<{
      source: TemplateSourceSnapshot;
      role: string;
      canRead: boolean;
      workspaceReadable: boolean;
    }>`
      WITH RECURSIVE source AS (
        SELECT p.*
        FROM pages p
        JOIN spaces s ON s.id = p.space_id AND s.workspace_id = p.workspace_id
        WHERE p.id = ${sourcePageId}::uuid
          AND p.workspace_id = ${actor.workspaceId}::uuid
          AND p.deleted_at IS NULL
          AND s.deleted_at IS NULL AND s.archived_at IS NULL
      ),
      ancestors AS (
        SELECT p.id, p.parent_page_id, p.workspace_id, p.space_id, p.deleted_at
        FROM source p
        UNION
        SELECT p.id, p.parent_page_id, p.workspace_id, p.space_id, p.deleted_at
        FROM pages p JOIN ancestors a ON a.parent_page_id = p.id
      ),
      live_groups AS (
        SELECT gu.user_id, gu.group_id
        FROM group_users gu
        JOIN groups g ON g.id = gu.group_id
        WHERE g.workspace_id = ${actor.workspaceId}::uuid AND g.deleted_at IS NULL
      ),
      readers AS (
        SELECT sm.user_id
        FROM space_members sm JOIN source p ON p.space_id = sm.space_id
        WHERE sm.deleted_at IS NULL
          AND sm.role IN ('reader', 'writer', 'admin') AND sm.user_id IS NOT NULL
        UNION
        SELECT lg.user_id
        FROM space_members sm
        JOIN source p ON p.space_id = sm.space_id
        JOIN live_groups lg ON lg.group_id = sm.group_id
        WHERE sm.deleted_at IS NULL AND sm.role IN ('reader', 'writer', 'admin')
      )
      SELECT
        jsonb_build_object(
          'id', p.id, 'workspaceId', p.workspace_id, 'spaceId', p.space_id,
          'title', p.title, 'icon', p.icon, 'content', p.content,
          'textContent', p.text_content
        ) AS source,
        u.role,
        (
          EXISTS (SELECT 1 FROM readers r WHERE r.user_id = u.id)
          AND NOT EXISTS (
            SELECT 1 FROM ancestors a
            JOIN page_access pa ON pa.page_id = a.id
            WHERE NOT EXISTS (
              SELECT 1 FROM page_permissions pp
              WHERE pp.page_access_id = pa.id AND pp.role IN ('reader', 'writer')
                AND (
                  pp.user_id = u.id OR EXISTS (
                    SELECT 1 FROM live_groups lg
                    WHERE lg.user_id = u.id AND lg.group_id = pp.group_id
                  )
                )
            )
          )
        ) AS "canRead",
        (
          s.visibility = 'open' AND NOT s.is_personal
          AND NOT EXISTS (
            SELECT 1 FROM ancestors a JOIN page_access pa ON pa.page_id = a.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM users audience
            WHERE audience.workspace_id = p.workspace_id
              AND audience.deleted_at IS NULL AND audience.deactivated_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM readers r WHERE r.user_id = audience.id)
          )
        ) AS "workspaceReadable"
      FROM source p
      JOIN spaces s ON s.id = p.space_id
      JOIN users u ON u.id = ${actor.id}::uuid AND u.workspace_id = p.workspace_id
      WHERE u.deleted_at IS NULL AND u.deactivated_at IS NULL
        AND u.role IN ('member', 'admin', 'owner')
        AND NOT EXISTS (
          SELECT 1 FROM ancestors a
          WHERE a.workspace_id <> p.workspace_id OR a.space_id <> p.space_id
            OR a.deleted_at IS NOT NULL
        )
    `.execute(trx);
    const result = rows[0];
    if (!result) {
      throw new NotFoundException('Template source not found');
    }
    if (!result.canRead) {
      throw new ForbiddenException('Template source is not readable');
    }
    if (!result.workspaceReadable) {
      const isAdmin =
        result.role === UserRole.ADMIN || result.role === UserRole.OWNER;
      if (!isAdmin || confirmRestrictedSource !== true) {
        throw new ForbiddenException(
          'Publishing a restricted source requires explicit workspace admin confirmation',
        );
      }
    }
    return result.source;
  }
}
