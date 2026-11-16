import { Injectable } from '@nestjs/common';
import { openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { type TrustedKeys } from '@wikisavvy/license';
import { EnvironmentService } from '../../integrations/environment/environment.service';

@Injectable()
export class LicenseTrustService {
  constructor(private readonly environment: EnvironmentService) {}

  getKeys(): TrustedKeys {
    const path = this.environment.getWikisavvyLicensePublicKeysFile();
    if (!path) return {};
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 32768) return {};
      const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
      const entries = Object.entries(value);
      if (
        entries.length > 32 ||
        entries.some(
          ([kid, pem]) =>
            !/^[a-zA-Z0-9_-]{1,64}$/.test(kid) ||
            typeof pem !== 'string' ||
            pem.length > 2048 ||
            pem.includes('PRIVATE KEY') ||
            !pem.startsWith('-----BEGIN PUBLIC KEY-----'),
        )
      )
        return {};
      return Object.fromEntries(entries) as TrustedKeys;
    } catch {
      return {};
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
