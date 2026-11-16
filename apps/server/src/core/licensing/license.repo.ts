import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../database/types/kysely.types';
import { dbOrTx } from '../../database/utils';

@Injectable()
export class WikisavvyLicenseRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  transaction<T>(callback: (trx: KyselyTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(callback);
  }

  async lockWorkspace(
    workspaceId: string,
    trx: KyselyTransaction,
  ): Promise<void> {
    const row = await trx
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', workspaceId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Workspace not found');
  }

  find(workspaceId: string, trx?: KyselyTransaction) {
    return dbOrTx(this.db, trx)
      .selectFrom('wikisavvyLicenses')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async activeMembers(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<number> {
    const result = await dbOrTx(this.db, trx)
      .selectFrom('users')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .where('deactivatedAt', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async save(
    workspaceId: string,
    encryptedLicense: string,
    actorId: string,
    trx: KyselyTransaction,
  ) {
    await trx
      .insertInto('wikisavvyLicenses')
      .values({ workspaceId, encryptedLicense, activatedBy: actorId })
      .onConflict((oc) =>
        oc.column('workspaceId').doUpdateSet({
          encryptedLicense,
          activatedBy: actorId,
          updatedAt: new Date(),
        }),
      )
      .execute();
  }

  async remove(workspaceId: string, trx: KyselyTransaction) {
    await trx
      .deleteFrom('wikisavvyLicenses')
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async recordEvent(
    workspaceId: string,
    actorId: string,
    action: 'activated' | 'removed',
    fingerprint: string | null,
    trx: KyselyTransaction,
  ) {
    await trx
      .insertInto('wikisavvyLicenseEvents')
      .values({ workspaceId, actorId, action, fingerprint })
      .execute();
  }
}
