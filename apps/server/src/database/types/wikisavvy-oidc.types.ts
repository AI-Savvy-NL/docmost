import { Generated, Timestamp } from './db';

export interface WikisavvyOidcProviders {
  id: Generated<string>;
  workspaceId: string;
  issuer: string;
  clientId: string;
  isEnabled: Generated<boolean>;
  createdAt: Generated<Timestamp>;
  encryptedClientSecret: string | null;
  revision: Generated<number>;
}

export interface WikisavvyOidcTransactions {
  stateHash: string;
  workspaceId: string;
  providerId: string;
  issuer: string;
  browserHash: string;
  encryptedPayload: string;
  expiresAt: Timestamp;
}

export interface WikisavvyOidcIdentities {
  id: Generated<string>;
  workspaceId: string;
  providerId: string;
  issuer: string;
  subject: string;
  userId: string;
  createdAt: Generated<Timestamp>;
}
