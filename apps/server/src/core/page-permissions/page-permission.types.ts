export type PermissionGrant = {
  type: 'user' | 'group';
  id: string;
  role: 'reader' | 'writer';
};

export type PermissionChange = {
  revision: string;
  grants: PermissionGrant[];
};

export type PermissionSnapshot = {
  pageId: string;
  revision: string;
  hasDirectRestriction: boolean;
  inheritedPageId: string | null;
  grants: PermissionGrant[];
};

export type PermissionPrincipal = {
  type: 'user' | 'group';
  id: string;
  name: string;
  email: string | null;
};
