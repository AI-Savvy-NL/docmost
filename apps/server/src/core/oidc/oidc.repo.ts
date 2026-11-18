import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '../../database/types/kysely.types';
import { dbOrTx } from '../../database/utils';
import { sql, type Insertable } from 'kysely';
import type { WikisavvyOidcTransactions } from '../../database/types/wikisavvy-oidc.types';

const publicProviderFields = [
  'id',
  'workspaceId',
  'issuer',
  'clientId',
  'isEnabled',
  'createdAt',
] as const;

export function assertOidcIssuer(issuer: string) {
  try {
    const parsed = new URL(issuer);
    if (
      typeof issuer !== 'string' ||
      issuer.length > 2048 ||
      !/^https:\/\/[^/@?#\\\s]+(?:\/[^?#\\\s]*)?$/i.test(issuer) ||
      Array.from(issuer).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
  } catch {
    throw new Error('Invalid OIDC issuer');
  }
}

@Injectable()
export class WikisavvyOidcRepo {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async insertProvider(
    value: { workspaceId: string; issuer: string; clientId: string },
    trx?: KyselyTransaction,
  ) {
    assertOidcIssuer(value.issuer);
    if (
      typeof value.clientId !== 'string' ||
      !value.clientId.trim() ||
      value.clientId.length > 512
    ) {
      throw new Error('Invalid OIDC client identifier');
    }
    return dbOrTx(this.db, trx)
      .insertInto('wikisavvyOidcProviders')
      .values({
        workspaceId: value.workspaceId,
        issuer: value.issuer,
        clientId: value.clientId,
        isEnabled: false,
      })
      .returning(publicProviderFields)
      .executeTakeFirstOrThrow();
  }

  findProvider(
    workspaceId: string,
    providerId: string,
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .selectFrom('wikisavvyOidcProviders')
      .select(publicProviderFields)
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', providerId)
      .executeTakeFirst();
  }

  async insertIdentity(
    value: {
      workspaceId: string;
      providerId: string;
      issuer: string;
      subject: string;
      userId: string;
    },
    trx: KyselyTransaction,
  ) {
    if (!trx?.isTransaction) {
      throw new Error('OIDC identity insertion requires a transaction');
    }
    assertOidcIssuer(value.issuer);
    if (
      typeof value.subject !== 'string' ||
      !value.subject.length ||
      value.subject.length > 255
    ) {
      throw new Error('Invalid OIDC subject');
    }
    return trx
      .insertInto('wikisavvyOidcIdentities')
      .values({
        workspaceId: value.workspaceId,
        providerId: value.providerId,
        issuer: value.issuer,
        subject: value.subject,
        userId: value.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  findIdentity(
    workspaceId: string,
    issuer: string,
    subject: string,
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .selectFrom('wikisavvyOidcIdentities')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('issuer', '=', issuer)
      .where('subject', '=', subject)
      .executeTakeFirst();
  }

  listProviders(workspaceId: string, enabledOnly = false) {
    return this.db
      .selectFrom('wikisavvyOidcProviders')
      .select(publicProviderFields)
      .where('workspaceId', '=', workspaceId)
      .$if(enabledOnly, (query) => query.where('isEnabled', '=', true))
      .orderBy('createdAt', 'asc')
      .execute();
  }

  identitiesForUser(workspaceId: string, userId: string) {
    return this.db
      .selectFrom('wikisavvyOidcIdentities')
      .select(['providerId'])
      .where('workspaceId', '=', workspaceId)
      .where('userId', '=', userId)
      .execute();
  }

  findConfiguration(
    workspaceId: string,
    providerId: string,
    trx?: KyselyTransaction,
  ) {
    return dbOrTx(this.db, trx)
      .selectFrom('wikisavvyOidcProviders')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', providerId)
      .executeTakeFirst();
  }

  lockConfiguration(
    workspaceId: string,
    providerId: string,
    trx: KyselyTransaction,
  ) {
    return trx
      .selectFrom('wikisavvyOidcProviders')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', providerId)
      .forShare()
      .executeTakeFirst();
  }

  saveConfiguration(
    workspaceId: string,
    providerId: string,
    encryptedClientSecret: string,
    isEnabled: boolean,
    revision: number,
    trx: KyselyTransaction,
  ) {
    return trx
      .updateTable('wikisavvyOidcProviders')
      .set({ encryptedClientSecret, isEnabled, revision: revision + 1 })
      .where('workspaceId', '=', workspaceId)
      .where('id', '=', providerId)
      .where('revision', '=', revision)
      .returning(publicProviderFields)
      .executeTakeFirst();
  }

  async insertTransaction(
    value: Insertable<WikisavvyOidcTransactions>,
    trx: KyselyTransaction,
  ) {
    await trx
      .deleteFrom('wikisavvyOidcTransactions')
      .where('workspaceId', '=', value.workspaceId)
      .where('expiresAt', '<=', new Date())
      .execute();
    await trx.insertInto('wikisavvyOidcTransactions').values(value).execute();
  }

  claimTransaction(
    workspaceId: string,
    stateHash: string,
    browserHash: string,
  ) {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('wikisavvyOidcTransactions')
        .select('stateHash')
        .where('workspaceId', '=', workspaceId)
        .where('stateHash', '=', stateHash)
        .where('browserHash', '=', browserHash)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return undefined;
      return trx
        .deleteFrom('wikisavvyOidcTransactions')
        .where('workspaceId', '=', workspaceId)
        .where('stateHash', '=', stateHash)
        .where('browserHash', '=', browserHash)
        .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
        .returningAll()
        .executeTakeFirst();
    });
  }
}
