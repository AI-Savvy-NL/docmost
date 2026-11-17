import { isAxiosError } from "axios";
import api from "@/lib/api-client.ts";

export type PermissionGrant = {
  type: "user" | "group";
  id: string;
  role: "reader" | "writer";
};

export type PermissionPrincipal = {
  type: "user" | "group";
  id: string;
  name: string;
  email: string | null;
};

export type PagePermissionState = {
  pageId: string;
  revision: string;
  hasDirectRestriction: boolean;
  inheritedPageId: string | null;
  canCreateRestriction: boolean;
  grants: Array<PermissionGrant & PermissionPrincipal>;
};

export class PagePermissionError extends Error {
  constructor(public readonly status?: number) {
    super("Page permission request could not be completed");
  }
}

export async function permissionRequest<T>(
  action: string,
  data: object,
): Promise<T> {
  try {
    const response = await api.post<T>(
      `/wikisavvy/page-permissions/${action}`,
      data,
    );
    return response.data;
  } catch (error) {
    throw new PagePermissionError(
      isAxiosError(error) ? error.response?.status : undefined,
    );
  }
}
