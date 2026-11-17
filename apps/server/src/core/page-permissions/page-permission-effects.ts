import { Injectable, Logger } from '@nestjs/common';
import { CollabAccessService } from '../../collaboration/services/collab-access.service';
import { WsService } from '../../ws/ws.service';

@Injectable()
export class WikisavvyPagePermissionEffects {
  private readonly logger = new Logger(WikisavvyPagePermissionEffects.name);

  constructor(
    private readonly collab: CollabAccessService,
    private readonly ws: WsService,
  ) {}

  async afterChange(pageId: string, spaceId: string): Promise<void> {
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        this.collab.recheckAccess({ pageIds: [pageId] }),
      ),
      Promise.resolve().then(() =>
        this.ws.removeBaseSubscribersWithoutAccess([pageId]),
      ),
      Promise.resolve().then(() =>
        this.ws.emitToSpace(spaceId, {
          operation: 'refetchRootTreeNodeEvent',
          spaceId,
        }),
      ),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      this.logger.warn(
        'Permission notification failed; fresh authorization remains authoritative',
      );
    }
  }
}
