import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import {
  WikisavvyLicenses,
  WikisavvyLicenseEvents,
} from './wikisavvy-license.types';

export interface DbInterface extends DB {
  pageEmbeddings: PageEmbeddings;
  wikisavvyLicenses: WikisavvyLicenses;
  wikisavvyLicenseEvents: WikisavvyLicenseEvents;
}
