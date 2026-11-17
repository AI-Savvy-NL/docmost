import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import {
  CacheKey,
  LATEST_VERSION_CACHE_TTL_MS,
} from '../../common/helpers/cache-keys';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageJson = require('./../../../package.json');

@Injectable()
export class VersionService {
  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  async getVersion() {
    const url = `https://api.github.com/repos/docmost/docmost/releases/latest`;

    let latestVersion: string | number = 0;
    try {
      const cached = await this.cacheManager.get<string>(
        CacheKey.LATEST_VERSION,
      );
      if (cached) {
        latestVersion = cached;
      } else {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = await response.json();
          latestVersion = data?.tag_name?.replace('v', '');
          await this.cacheManager.set(
            CacheKey.LATEST_VERSION,
            latestVersion,
            LATEST_VERSION_CACHE_TTL_MS,
          );
        }
      }
    } catch (err) {
      /* empty */
    }

    const revision = process.env.WIKISAVVY_BUILD_REVISION ?? '';
    const date = process.env.WIKISAVVY_BUILD_DATE ?? '';
    const timestamp = Date.parse(date);
    const validBuild =
      /^[0-9a-f]{40}$/.test(revision) &&
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === date;

    return {
      currentVersion: packageJson?.version,
      releaseVersion: validBuild
        ? `${date.replaceAll('-', '.')}-${revision.slice(0, 8)}`
        : null,
      buildRevision: validBuild ? revision : null,
      latestVersion: latestVersion,
      releaseUrl: 'https://github.com/docmost/docmost/releases',
    };
  }
}
