import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  PagePermissionState,
  permissionRequest,
  PermissionGrant,
  PermissionPrincipal,
} from "./page-permission-api";

export function usePagePermissionState(pageId: string, opened: boolean) {
  return useQuery({
    queryKey: ["wikisavvy-page-permissions", pageId],
    queryFn: () => permissionRequest<PagePermissionState>("info", { pageId }),
    enabled: Boolean(pageId) && opened,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function usePermissionPrincipals(pageId: string, query: string) {
  return useQuery({
    queryKey: ["wikisavvy-permission-principals", pageId, query],
    queryFn: () =>
      permissionRequest<PermissionPrincipal[]>("principals", { pageId, query }),
    retry: false,
    gcTime: 0,
  });
}

export function useSavePagePermissions(
  pageId: string,
  revision: string,
  onSaved: () => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (grants: PermissionGrant[] | null) =>
      grants === null
        ? permissionRequest("remove", { pageId, revision })
        : permissionRequest("set", { pageId, revision, grants }),
    onSuccess: () => {
      onSaved();
      for (const key of [
        "pages",
        "sidebar-pages",
        "root-sidebar-pages",
        "breadcrumbs",
        "wikisavvy-page-permissions",
      ]) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
    retry: false,
  });
}
