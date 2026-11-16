import { Generated, Timestamp } from './db';

export interface WikisavvyLicenses {
  workspaceId: string;
  encryptedLicense: string;
  activatedBy: string | null;
  createdAt: Generated<Timestamp>;
  updatedAt: Generated<Timestamp>;
}

export interface WikisavvyLicenseEvents {
  id: Generated<string>;
  workspaceId: string;
  actorId: string | null;
  action: 'activated' | 'removed';
  fingerprint: string | null;
  createdAt: Generated<Timestamp>;
}
