import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LicenseTrustService } from './license-trust.service';

describe('Offline issuer trust file', () => {
  let directory: string;
  let path: string;
  let service: LicenseTrustService;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'wikisavvy-public-trust-'));
    path = join(directory, 'public.json');
    writeFileSync(path, '{}');
    service = new LicenseTrustService({
      getWikisavvyLicensePublicKeysFile: () => path,
    } as any);
  });
  afterEach(() => {
    unlinkSync(path);
    rmdirSync(directory);
  });
  it('loads explicitly configured public keys and picks up rotation', () => {
    const key = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    writeFileSync(path, JSON.stringify({ first: key }));
    expect(Object.keys(service.getKeys())).toEqual(['first']);
    writeFileSync(path, JSON.stringify({ first: key, rotated: key }));
    expect(Object.keys(service.getKeys())).toEqual(['first', 'rotated']);
  });
  it('fails closed for malformed, oversized or private key material', () => {
    for (const value of [
      'not-json',
      ' '.repeat(32769),
      JSON.stringify({ first: '-----BEGIN PRIVATE KEY-----' }),
      JSON.stringify({ first: 123 }),
    ]) {
      writeFileSync(path, value);
      expect(service.getKeys()).toEqual({});
    }
  });
  it('does not prevent Community startup when trust is unconfigured', () => {
    const unconfigured = new LicenseTrustService({
      getWikisavvyLicensePublicKeysFile: () => undefined,
    } as any);
    expect(unconfigured.getKeys()).toEqual({});
  });
  it('rejects private material appended to a valid public PEM', () => {
    const keys = generateKeyPairSync('ed25519');
    const publicPem = keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const privatePem = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    writeFileSync(path, JSON.stringify({ first: publicPem + privatePem }));
    expect(Object.keys(service.getKeys())).toEqual([]);
  });
});
