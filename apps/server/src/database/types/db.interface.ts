import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import {
  WikisavvyLicenses,
  WikisavvyLicenseEvents,
} from './wikisavvy-license.types';
import { WikisavvyPagePermissionRevisions } from './wikisavvy-page-permission.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  wikisavvyLicenses: WikisavvyLicenses;
  wikisavvyLicenseEvents: WikisavvyLicenseEvents;
  wikisavvyPagePermissionRevisions: WikisavvyPagePermissionRevisions;
}
