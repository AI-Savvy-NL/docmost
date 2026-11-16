import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  effectiveCapabilities,
  graceEndsAt,
  hasSeat,
  IMPLEMENTED_CAPABILITIES,
  licenseState,
  verifyLicense,
  type LicenseClaims,
  type LicenseState,
  type LicenseStatus,
} from '@wikisavvy/license';
import {
  EncryptionPurpose,
  EncryptionService,
} from '../../integrations/encryption/encryption.service';
import { KyselyTransaction } from '../../database/types/kysely.types';
import { WikisavvyLicenseRepo } from './license.repo';
import { LicenseTrustService } from './license-trust.service';

@Injectable()
export class LicensingService {
  constructor(
    private readonly repository: WikisavvyLicenseRepo,
    private readonly trust: LicenseTrustService,
    private readonly encryption: EncryptionService,
  ) {}

  lockWorkspace(workspaceId: string, trx: KyselyTransaction) {
    return this.repository.lockWorkspace(workspaceId, trx);
  }

  private async snapshot(workspaceId: string, trx?: KyselyTransaction) {
    const row = await this.repository.find(workspaceId, trx);
    const active = await this.repository.activeMembers(workspaceId, trx);
    const trustedKeys = this.trust.getKeys();
    let claims: LicenseClaims | undefined;
    let state: LicenseState | 'community' | 'invalid' = row
      ? 'invalid'
      : 'community';
    if (row) {
      try {
        const envelope = this.encryption.decrypt(
          row.encryptedLicense,
          EncryptionPurpose.WIKISAVVY_LICENSE,
        );
        claims = verifyLicense(envelope, trustedKeys, workspaceId);
        state = licenseState(claims);
      } catch {
        state = 'invalid';
      }
    }
    return {
      claims,
      state,
      active,
      trustConfigured: Object.keys(trustedKeys).length > 0,
    };
  }

  async status(
    workspaceId: string,
    trx?: KyselyTransaction,
  ): Promise<LicenseStatus> {
    const { claims, state, active, trustConfigured } = await this.snapshot(
      workspaceId,
      trx,
    );
    const entitled = state === 'valid' || state === 'grace';
    return {
      workspaceId,
      edition: entitled ? 'enterprise' : 'community',
      status: state,
      trustConfigured,
      features: claims && entitled ? effectiveCapabilities(claims, state) : [],
      implementedCapabilities: [...IMPLEMENTED_CAPABILITIES],
      seats: {
        active,
        limit: claims?.seats ?? null,
        overLimit: claims?.seats != null && active > claims.seats,
      },
      license: claims
        ? {
            licenseId: claims.licenseId,
            licensee: claims.licensee,
            issuedAt: claims.issuedAt,
            notBefore: claims.notBefore,
            expiresAt: claims.expiresAt,
            graceEndsAt: graceEndsAt(claims).toISOString(),
            capabilities: claims.capabilities,
          }
        : null,
    };
  }

  async activate(workspaceId: string, actorId: string, envelope: string) {
    return this.repository.transaction(async (trx) => {
      await this.repository.lockWorkspace(workspaceId, trx);
      let claims: LicenseClaims;
      try {
        claims = verifyLicense(envelope, this.trust.getKeys(), workspaceId);
      } catch {
        throw new BadRequestException('Invalid or untrusted WikiSavvy license');
      }
      const state = licenseState(claims);
      if (state !== 'valid' && state !== 'grace') {
        throw new BadRequestException(
          'License is not currently valid or within its grace period',
        );
      }
      await this.repository.save(
        workspaceId,
        this.encryption.encrypt(envelope, EncryptionPurpose.WIKISAVVY_LICENSE),
        actorId,
        trx,
      );
      await this.repository.recordEvent(
        workspaceId,
        actorId,
        'activated',
        createHash('sha256').update(envelope).digest('hex'),
        trx,
      );
      return this.status(workspaceId, trx);
    });
  }

  async remove(workspaceId: string, actorId: string) {
    return this.repository.transaction(async (trx) => {
      await this.repository.lockWorkspace(workspaceId, trx);
      await this.repository.remove(workspaceId, trx);
      await this.repository.recordEvent(
        workspaceId,
        actorId,
        'removed',
        null,
        trx,
      );
      return this.status(workspaceId, trx);
    });
  }

  async assertSeatAvailable(
    workspaceId: string,
    trx: KyselyTransaction,
  ): Promise<void> {
    await this.repository.lockWorkspace(workspaceId, trx);
    const { claims, state, active } = await this.snapshot(workspaceId, trx);
    if (
      claims &&
      (state === 'valid' || state === 'grace') &&
      !hasSeat(claims, state, active)
    ) {
      throw new ForbiddenException(
        'Licensed seat limit reached. Deactivate a member or update the license.',
      );
    }
  }
}
